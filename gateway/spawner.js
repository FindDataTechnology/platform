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
import { mkdir, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import path from "node:path";

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
      cells.set(userId, cell);

      const env = {
        ...baseEnv,
        PORT: String(port),
        HOST: "127.0.0.1",
        PLATFORM_DATA_DIR: path.join(root, "data"),
        DSH_HOME: path.join(root, "dsh"),
        MCP_CONFIG_PATH: path.join(root, "mcp.json"),
        AUTH_MODE: "forward_auth",
        CLOUD_MODE: "1",
        CELL_GATEWAY_SECRET: secret,
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

      await waitForPort(port, startTimeoutMs, () => child.exitCode !== null);
      cell.state = "running";
      console.log(`[gateway] cell ${userId} running on 127.0.0.1:${port} (pid ${cell.pid})`);
      return cell;
    })();
  }

  // `inflight` collapses concurrent first requests for the same user onto one
  // spawn — the "starting" state two parallel requests would otherwise both
  // observe, each launching its own cell.
  function ensure(user) {
    const userId = userIdFor(user.email);
    const existing = cells.get(userId);
    if (existing && existing.state === "running") {
      existing.lastTraffic = Date.now();
      return Promise.resolve(existing);
    }
    if (existing?.starting) return existing.starting;
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
      const cell = cells.get(userId);
      if (cell) delete cell.starting;
    });
    const cell = cells.get(userId);
    if (cell) cell.starting = started;
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

  // Forget a cell record without stopping anything: for a process that died
  // out from under the gateway (crash, SIGKILL), where the stale "running"
  // record would otherwise send every future ensure() to a dead port. The
  // next ensure() spawns fresh. A no-op when the user has no record.
  function drop(userId) {
    return cells.delete(userId);
  }

  return { ensure, record, status, stop, drop, shutdown, cells };
}
