// ── Cell spawner ─────────────────────────────────────────────────────────────
//
// Maps a verified identity to a running cell (one server.js process + its dsh
// child + a per-user data root) and owns that process's lifecycle: spawn on
// first traffic, health via the cell's listening port, optional idle reaping,
// and reaping every child on gateway shutdown.
//
// This is the seam Phase 3 replaces: swapping `spawn()` for a k8s client is
// meant to touch nothing else, so everything orchestration-shaped lives here.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import path from "node:path";
import { bundledJson } from "../paths.js";

// A stable, filesystem-safe per-user directory name. Derived by hashing rather
// than by sanitizing the email so a hostile address can never contribute a path
// segment (`..`, a leading `/`) — the mapping is one-way and the email itself
// stays in the cell's own DB.
export function userIdFor(email) {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 16);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Resolve once something accepts connections on the port. The cell's own boot
// is listen-first (server.js listens before the dsh agent finishes), so a
// listening port means the app can answer; the client's WS gets the app's own
// `initializing` event and a later ready-sync, rather than the gateway holding
// the request for the full agent boot.
function waitForPort(port, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (isDead()) return reject(new Error("cell process exited during startup"));
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) return reject(new Error(`cell did not listen on ${port} within ${timeoutMs}ms`));
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

export function createCellRegistry(config) {
  const {
    dataRoot,
    secret,
    startTimeoutMs,
    idleReapSecs,
    serverEntry,
    env: baseEnv,
    // Demo-cell bounds (openspec: mp-demo-mode). Demo cells are bounded in
    // both directions account cells are not: at most demoMaxCells running at
    // once, and a short demoIdleReapSecs idle window that applies regardless
    // of the deployment-wide reap setting.
    demoMaxCells = 3,
    demoIdleReapSecs = 900,
  } = config;
  const cells = new Map();
  // In-flight spawns, keyed by userId. Registered BEFORE spawnCell() is called
  // — the cell record only exists once spawnCell has awaited a free port and
  // its mkdirs, so a guard reading cells.get(userId).starting cannot collapse
  // two requests that both arrive during that window. (That was the
  // 2026-10-10 duplicate-spawn defect: two cells for one user, the older one
  // orphaned and never reaped.)
  const inflight = new Map();
  let shuttingDown = false;
  let reaper = null;

  function record(user) {
    const userId = userIdFor(user.email);
    return cells.get(userId);
  }

  function runningDemoCount() {
    let n = 0;
    for (const c of cells.values()) {
      if (c.demo && (c.state === "running" || c.state === "starting")) n++;
    }
    return n;
  }

  // Terminate a cell process and wait for it to actually exit: SIGTERM first,
  // escalating to SIGKILL once the grace period lapses. A cell that ignores
  // SIGTERM (wedged dsh child) must not keep the host's memory — or the cell's
  // SQLite stores — forever, and a replacement must never leave two live
  // processes writing the same data root.
  const KILL_GRACE_MS = 5000;
  async function terminateChild(child, userId) {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      let settled = false;
      let escalate = null;
      let cap = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (escalate) clearTimeout(escalate);
        if (cap) clearTimeout(cap);
        resolve();
      };
      child.once("exit", done);
      // Re-check after subscribing: an exit between the caller's check and the
      // listener attach would otherwise only be caught by the backstop timer.
      if (child.exitCode !== null) return done();
      child.kill("SIGTERM");
      escalate = setTimeout(() => {
        if (child.exitCode === null) {
          console.warn(`[gateway] cell ${userId} ignored SIGTERM for ${KILL_GRACE_MS}ms — SIGKILL`);
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
      escalate.unref?.();
      // SIGKILL is not ignorable, so this is a backstop, not an expected path.
      cap = setTimeout(done, KILL_GRACE_MS + 1000);
      cap.unref?.();
    });
  }

  function spawnCell(user) {
    const userId = userIdFor(user.email);
    const root = path.join(dataRoot, userId);
    const demo = Boolean(user.groups?.includes?.("demo"));
    return (async () => {
      const port = await freePort();
      await mkdir(root, { recursive: true });
      // Per-user cwd and workspace (tenant-cell-runtime): the process cwd must
      // sit inside the user's own root so the workspace boot chain's cwd
      // fallback tier can never land on a cross-cell shared directory, and any
      // accidental relative-path write stays contained. Bundled read-only
      // assets resolve via repoRoot() (paths.js), not cwd, so the code is
      // still found.
      const runtimeDir = path.join(root, "runtime");
      const workspaceDir = path.join(root, "workspace");
      await mkdir(runtimeDir, { recursive: true });
      await mkdir(workspaceDir, { recursive: true });
      const cell = {
        userId,
        email: user.email,
        demo,
        state: "starting",
        port,
        pid: null,
        child: null,
        startedAt: Date.now(),
        lastTraffic: Date.now(),
        error: null,
      };
      // A record is replaced only by terminating its process first. Writing
      // over a live record orphans the process: it keeps running with no
      // record, so nothing routes to it and nothing reaps it — and it keeps
      // holding the cell's SQLite stores. That is the 2026-10-10 defect.
      const previous = cells.get(userId);
      if (previous?.child && previous.child.exitCode === null) {
        console.warn(`[gateway] cell ${userId} record replaced while its process was alive — terminating pid ${previous.pid}`);
        // Mark it stopping so its exit handler treats the death as deliberate
        // (no "exited unexpectedly" line for a process we just killed).
        previous.state = "stopping";
        await terminateChild(previous.child, userId);
      }
      cells.set(userId, cell);

      // The operator MCP baseline (mcp.json) is read-only deployment config,
      // not per-cell state: a cell-private file would have to be seeded and
      // kept in sync by someone, and nobody does. Point cells at the shared
      // image copy (the spawner runs cells from the repo, so the same file the
      // gateway sees), while still honoring a per-cell override when an
      // operator drops one in for a specific user. Without this fallback the
      // baseline is invisible to cells: writeMcpPatch read <cell>/mcp.json,
      // which never exists, so operator servers (the connector row) silently
      // never reached any dsh profile (2026-10-10 fd-prod gap).
      const cellMcpJson = path.join(root, "mcp.json");
      const env = {
        ...baseEnv,
        PORT: String(port),
        HOST: "127.0.0.1",
        PLATFORM_DATA_DIR: path.join(root, "data"),
        DSH_HOME: path.join(root, "dsh"),
        MCP_CONFIG_PATH: existsSync(cellMcpJson) ? cellMcpJson : bundledJson("mcp.json"),
        AUTH_MODE: "forward_auth",
        CLOUD_MODE: "1",
        CELL_GATEWAY_SECRET: secret,
        // Cells live behind the gateway, which owns the auth entry/exit routes
        // (sole Logto client; no /oauth2/* edge exists in this topology). Cells
        // must advertise these in /api/auth/me so the UI never targets a dead
        // route — revisit if an oauth2-proxy edge ever returns.
        AUTH_LOGIN_PATH: "/auth/login",
        AUTH_LOGOUT_PATH: "/api/auth/logout",
        // The cell's user, so bindings saved earlier apply at boot rather than
        // waiting for the first request (a cell has exactly one user).
        CELL_USER_EMAIL: user.email,
        // Authoritative per-cell workspace: placed AFTER the baseEnv spread so
        // an inherited gateway-level AGENT_WORKSPACE can never merge two cells
        // onto one directory (spec: "inherited environment cannot merge
        // workspaces").
        AGENT_WORKSPACE: workspaceDir,
      };
      const child = spawn(process.execPath, [serverEntry], { cwd: runtimeDir, env, stdio: ["ignore", "pipe", "pipe"] });
      cell.child = child;
      cell.pid = child.pid;
      child.stdout.on("data", (buf) => process.stdout.write(`[cell ${userId}] ${buf}`));
      child.stderr.on("data", (buf) => process.stderr.write(`[cell ${userId}] ${buf}`));
      child.on("exit", (code, signal) => {
        // A cell that exits unexpectedly is marked so its user's next traffic
        // respawns it; other users' cells are untouched.
        if (cells.get(userId) !== cell) return;
        // Demo state is discardable by definition (openspec: mp-demo-mode):
        // whether stopped on purpose or crashed, its data root goes with the
        // process so curious traffic cannot accumulate garbage. The guard
        // above already ensures a respawned cell's fresh directory is never
        // the one deleted here.
        if (cell.demo) {
          void rm(root, { recursive: true, force: true }).catch((e) =>
            console.warn(`[gateway] demo cell ${userId} data cleanup failed: ${e.message}`)
          );
        }
        if (cell.state === "stopping") {
          cells.delete(userId);
          return;
        }
        cell.state = "error";
        cell.error = `exited (code=${code} signal=${signal})`;
        cell.child = null;
        console.error(`[gateway] cell ${userId} exited unexpectedly: ${cell.error}`);
      });

      try {
        await waitForPort(port, startTimeoutMs, () => child.exitCode !== null);
      } catch (err) {
        // A cell that never came up must not leave a "starting" record behind:
        // the next ensure() would see a non-running record, spawn again, and
        // this dead process would still be holding the port's listener slot.
        // Terminate it, and drop the record when it is still ours.
        cell.state = "error";
        cell.error = err.message;
        await terminateChild(child, userId);
        if (cells.get(userId) === cell) cells.delete(userId);
        throw err;
      }
      cell.state = "running";
      console.log(`[gateway] cell ${userId} running on 127.0.0.1:${port} (pid ${cell.pid})`);
      return cell;
    })();
  }

  // Concurrent first requests for the same user collapse onto one spawn. The
  // in-flight promise is registered BEFORE spawnCell() runs: spawnCell awaits a
  // free port and three mkdirs before it writes the cell record, so any guard
  // reading the record (cells.get(userId).starting) misses exactly the window
  // two parallel requests would both observe.
  function ensure(user) {
    const userId = userIdFor(user.email);
    const existing = cells.get(userId);
    if (existing && existing.state === "running") {
      existing.lastTraffic = Date.now();
      return Promise.resolve(existing);
    }
    const pending = inflight.get(userId);
    if (pending) return pending;
    // Demo pool bound (openspec: mp-demo-mode): a full pool is an expected,
    // friendly condition, so the error carries a machine-readable code and a
    // user-facing message rather than a raw spawn failure.
    if (user.groups?.includes?.("demo") && runningDemoCount() >= demoMaxCells) {
      const err = new Error("demo capacity reached");
      err.code = "demo_capacity";
      err.friendly = "当前体验人数较多，请稍后再试";
      return Promise.reject(err);
    }
    const started = spawnCell(user).finally(() => {
      inflight.delete(userId);
    });
    inflight.set(userId, started);
    return started;
  }

  function stop(userId, reason) {
    const cell = cells.get(userId);
    if (!cell) return false;
    cell.state = "stopping";
    cell.child?.kill("SIGTERM");
    // A cell that ignores SIGTERM (wedged dsh child) must not keep the host's
    // memory forever; escalate once the grace period lapses.
    const child = cell.child;
    setTimeout(() => { if (child && child.exitCode === null) child.kill("SIGKILL"); }, 5000).unref();
    console.log(`[gateway] cell ${userId} stopping (${reason})`);
    return true;
  }

  async function enabledScheduledWork(cell) {
    const res = await fetch(`http://127.0.0.1:${cell.port}/api/gateway/jobs`, {
      headers: { "x-forwarded-email": cell.email, "x-cloud-gateway-secret": secret },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`jobs probe HTTP ${res.status}`);
    return res.json();
  }

  async function reapIdle() {
    if (shuttingDown) return;
    const accountCutoff = Date.now() - idleReapSecs * 1000;
    const demoCutoff = Date.now() - demoIdleReapSecs * 1000;
    for (const cell of [...cells.values()]) {
      if (cell.state !== "running") continue;
      // Demo cells: bounded lifetime regardless of the deployment-wide reap
      // setting and regardless of the scheduled-job exemption — a demo cell
      // has nothing of the user's worth preserving (openspec: mp-demo-mode).
      // stop() runs the exit handler, which deletes the demo data root.
      if (cell.demo) {
        if (cell.lastTraffic <= demoCutoff) stop(cell.userId, "demo idle");
        continue;
      }
      if (idleReapSecs <= 0 || cell.lastTraffic > accountCutoff) continue;
      let work;
      try {
        work = await enabledScheduledWork(cell);
      } catch (err) {
        console.warn(`[gateway] cell ${cell.userId} jobs probe failed (${err.message}); not reaping`);
        continue;
      }
      if (work.enabledCron || work.enabledBots) {
        console.log(`[gateway] cell ${cell.userId} idle but holds ${work.enabledCron} cron / ${work.enabledBots} bot job(s); keeping it up`);
        continue;
      }
      stop(cell.userId, "idle");
    }
  }

  // The reaper runs when EITHER window is configured: demo cells need reaping
  // even on deployments that keep account cells resident forever.
  if (idleReapSecs > 0 || demoIdleReapSecs > 0) {
    const fastest = Math.min(
      idleReapSecs > 0 ? idleReapSecs : Infinity,
      demoIdleReapSecs > 0 ? demoIdleReapSecs : Infinity,
    );
    const everyMs = Math.max(5000, Math.min(60_000, fastest * 250));
    reaper = setInterval(() => { reapIdle().catch((e) => console.warn(`[gateway] reaper failed: ${e.message}`)); }, everyMs);
    reaper.unref();
  }

  function status() {
    return [...cells.values()].map((cell) => ({
      user: cell.email,
      userId: cell.userId,
      demo: Boolean(cell.demo),
      state: cell.state,
      pid: cell.pid,
      port: cell.port,
      lastTraffic: new Date(cell.lastTraffic).toISOString(),
      uptimeMs: Date.now() - cell.startedAt,
      error: cell.error,
    }));
  }

  async function shutdown() {
    shuttingDown = true;
    if (reaper) clearInterval(reaper);
    const victims = [...cells.keys()];
    for (const userId of victims) stop(userId, "gateway shutdown");
    await new Promise((r) => setTimeout(r, 800));
    for (const cell of cells.values()) {
      if (cell.child && cell.child.exitCode === null) cell.child.kill("SIGKILL");
    }
  }

  // Forget a cell record. Intended for a process that died out from under the
  // gateway (crash, SIGKILL), where the stale "running" record would otherwise
  // send every future ensure() to a dead port. A record is never removed while
  // its process is alive: that would orphan the process — running, unrouted,
  // unreapable, and still holding the cell's SQLite stores (2026-10-10
  // defect). A live process is routed through stop() instead, so the record
  // disappears in the exit handler once the process is actually gone. A no-op
  // when the user has no record.
  function drop(userId) {
    const cell = cells.get(userId);
    if (!cell) return false;
    if (cell.child && cell.child.exitCode === null) {
      console.warn(`[gateway] drop(${userId}) called with a live process — stopping pid ${cell.pid} instead`);
      return stop(userId, "drop with live process");
    }
    return cells.delete(userId);
  }

  return { ensure, record, status, stop, drop, shutdown, cells };
}
