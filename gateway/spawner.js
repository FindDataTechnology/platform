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
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import path from "node:path";
import { bundledJson } from "../paths.js";
import Database from "better-sqlite3";
import { newRegistryRow } from "../lib/cell-registry.js";
import { createDiskMeter } from "./cell-disk.js";

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
    // Liveness the reaper cannot see in `lastTraffic`: an attached WebSocket
    // produces NO HTTP `ensure()` calls for the life of the socket, so a chat
    // sitting on its connection looked idle and the cell was SIGTERMed mid-turn.
    // A predicate `(cellId) => boolean` from the caller (the gateway owns the
    // socket table); null keeps the module byte-for-byte legacy.
    isActive = null,
    serverEntry,
    env: baseEnv,
    // Demo-cell bounds (openspec: mp-demo-mode). Demo cells are bounded in
    // both directions account cells are not: at most demoMaxCells running at
    // once, and a short demoIdleReapSecs idle window that applies regardless
    // of the deployment-wide reap setting.
    demoMaxCells = 3,
    demoIdleReapSecs = 900,
    // add-cell-lifecycle 3.x: the DURABLE registry. When present, spawn /
    // suspend / destroy decisions ride it (and a gateway restart rebuilds the
    // demand surface from it, not from traffic); when absent the module runs
    // byte-for-byte legacy (unit tests keep the in-memory world).
    registryDb = null,
    initialPolicy = "on_demand",
    // harden-platform-memory-carrier: the residency admission gate. `procMemory`
    // is a lib/proc-memory sampler (admission(threshold) → verdict); when
    // unwired or the floor is <= 0 the module runs byte-for-byte legacy. The
    // SAME sampler instance the /api/monitoring/memory face reads — one scan,
    // no gate/face disagreement.
    procMemory = null,
    memoryFloor = 0.15,
    // add-wake-budget-admission: the contribution booked for a residency with
    // no archived footprint (MB, 0 disables → legacy current-only degrade).
    wakeDefaultFootprintMb = 512,
    // fix-stale-wake-footprint: how long an archived footprint stays authoritative.
    // Past this age the archive is treated as ABSENT (the wake is judged on the
    // default footprint — exactly the "this cell has never been measured" path
    // that already ships), then the next park re-archives a fresh number. That
    // breaks the self-lock: a cell whose archive is too big to admit can never
    // wake, so it can never re-measure.
    footprintTtlMs = 6 * 60 * 60 * 1000,
  } = config;
  const cells = new Map();
  // In-flight spawns, keyed by userId. Registered BEFORE spawnCell() is called
  // — the cell record only exists once spawnCell has awaited a free port and
  // its mkdirs, so a guard reading cells.get(userId).starting cannot collapse
  // two requests that both arrive during that window. (That was the
  // 2026-10-10 duplicate-spawn defect: two cells for one user, the older one
  // orphaned and never reaped.)
  const inflight = new Map();
  // Wake reservation ledger (add-wake-budget-admission): cellId → the bytes
  // its residency admission booked (archived footprint or the conservative
  // default). Concurrent wakes inside one sampler TTL window must see each
  // other's contributions, not share one pre-wake snapshot (the 2026-11-04
  // roll-restart OOM window). Registered BEFORE the verdict, released when
  // the residency settles (materialized or failed) — never leaks.
  const inflightWakes = new Map();
  const defaultFootprintBytes = Math.max(0, Math.round(wakeDefaultFootprintMb * 1024 * 1024));
  const gateArmed = () => Boolean(procMemory && memoryFloor > 0);

  // ── Crash backoff (add-cell-crash-ledger) ────────────────────────────────
  // A cell that crashes on every spawn must not be retried in a tight loop, but
  // it must never be REFUSED either: refusing would lock the user out of their
  // own data with no path back (the mp-demo tombstone lesson above). So the
  // only lever is the delay before the next spawn, and it is deliberately
  // UX-first: the ceiling is one wake's worth of waiting (boot is 8.6–12s), so
  // the worst case a user feels is "slightly slower than a cold start" instead
  // of "it is broken". All three knobs are deployment-tunable.
  const cfgEnv = baseEnv ?? process.env;
  const crashBackoffBaseMs = Math.max(0, Number(cfgEnv.CELL_CRASH_BACKOFF_BASE_MS ?? 1000));
  const crashBackoffMaxMs = Math.max(0, Number(cfgEnv.CELL_CRASH_BACKOFF_MAX_MS ?? 15000));
  const crashWindowMs = Math.max(1, Number(cfgEnv.CELL_CRASH_WINDOW_MS ?? 10 * 60 * 1000));
  const crashRehabMs = Math.max(0, Number(cfgEnv.CELL_CRASH_REHAB_MS ?? 10 * 60 * 1000));

  // Crashes only inside the window count toward the delay; a cell that has been
  // quiet longer than that starts from zero (its crash was not a loop).
  function crashDelayMs(row) {
    const count = Number(row?.crashCount ?? 0);
    const at = Number(row?.lastCrash?.at ?? 0);
    if (!(count > 0) || !at) return 0;
    if (Date.now() - at > crashWindowMs) return 0;
    return Math.min(crashBackoffMaxMs, crashBackoffBaseMs * 2 ** Math.min(count - 1, 16));
  }

  // Sum of OTHER wakes' reservations (the caller's own entry excluded — it is
  // fed separately as the wake's own contribution).
  function inflightBytesExcluding(userId) {
    let sum = 0;
    for (const [id, bytes] of inflightWakes) {
      if (id !== userId) sum += bytes;
    }
    return sum;
  }
  let shuttingDown = false;
  let reaper = null;

  // ── Durable registry glue (add-cell-lifecycle 3.1/3.2) ───────────────────
  // One transition call per lifecycle beat; the executor side effects stay
  // here (spawn/kill), the durable truth rides registryDb. A registry write
  // failure never blocks a spawn — demand surface first, at its own truth
  // catch-up next boot (and the duty-ring tick refreshes workload anyway).
  function reg(cellId, event, opts = {}) {
    if (!registryDb) return null;
    try {
      const r = registryDb.fire(cellId, event, opts);
      if (r?.error) console.warn(`[gateway] cell registry ${event.type} refused for ${cellId}: ${r.error}`);
      return r;
    } catch (e) {
      console.warn(`[gateway] cell registry write failed for ${cellId}: ${e?.message || e}`);
      return null;
    }
  }

  // Boot catch-up: rows for every data-root the registry has never seen —
  // seeded as `suspended` (the pre-roll world had processes down with demand
  // standing), NOT `unbound` (never-bound), so the duty ring can wake them.
  // ownerEmail rides out of the cell's own app.db user_registry_credentials
  // when the hash can't tell — otherwise the first traffic binds it.
  // Reader with failure isolation: a wedged store must not close the door —
  // callers degrade to in-memory rules instead of refusing traffic.
  function registryRowForSafe(userId) {
    try { return registryDb?.get(userId) ?? null; } catch { return null; }
  }

  // Read-only owner recovery: <root>/data/data/app.db → user_registry_credentials.
  // Unknown/blank answers never fake a binding; every existing fleet cell has
  // connected the platform registry at least once (§量产实证 2026-10-27).
  function backfillOwnerEmail(root) {
    try {
      const db = new Database(path.join(root, "data", "data", "app.db"), { readonly: true });
      try {
        const row = db.prepare("SELECT email FROM user_registry_credentials WHERE email IS NOT NULL AND email != '' ORDER BY rowid LIMIT 1").get();
        return row?.email ?? null;
      } finally { db.close(); }
    } catch { return null; }
  }

  function backfillRegistry() {
    if (!registryDb) return;
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cellId = entry.name;
      if (!/^[0-9a-f]{16}$/i.test(cellId)) continue;
      const email = backfillOwnerEmail(path.join(dataRoot, cellId));
      const current = registryDb.get(cellId);
      // Idempotent rescue: an earlier blind seed (unbound, no email) upgrades
      // by put + down — `register` is refused on existing rows by design.
      if (current && !(current.ownerEmail == null || current.state === "unbound")) continue;
      try {
        if (!current) {
          registryDb.fire(cellId, { type: "register", ownerEmail: email, now: Date.now() }, { policy: initialPolicy });
        } else if (email && !current.ownerEmail) {
          registryDb.put({ ...current, ownerEmail: email });
        }
        registryDb.fire(cellId, { type: "down", now: Date.now() });
      } catch (e) { console.warn(`[gateway] registry backfill failed for ${cellId}: ${e?.message || e}`); }
    }
  }
  if (registryDb) {
    const n = (() => {
      try {
        const before = registryDb.all().length;
        backfillRegistry();
        return registryDb.all().length - before;
      } catch { return 0; }
    })();
    if (n > 0) console.log(`[gateway] cell registry backfill: ${n} row(s) seeded from data root`);
  }

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

  // ── Durable registry bridge (add-cell-lifecycle 3.1/3.4) ─────────────────
  //
  // When registryDb is present, spawn/suspend/destroy decisions also LAND in
  // the persistent store: a rolled gateway rebuilds who exists, what they
  // owe, and what must re-arm — without waiting for anyone to come back.
  // Legacy deployments (no registryDb) keep the byte-for-byte pre-change
  // behavior, including the scheduled-work reaping exemption.
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
    // Lifecycle beat ①: unbound/suspended → starting. Demo cells stand as
    // ephemeral policy; everyone else inherits `initialPolicy` (spec default
    // on_demand — a new cell waits for demand, never resident by default).
    reg(userId, { type: "bindRequested", ownerEmail: user.email, now: Date.now() }, { policy: demo ? "ephemeral" : initialPolicy });
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
          // mp-demo-mode spec: "the demo can cold-start again after cleanup" —
          // expiry parks the row (down) rather than writing the terminal
          // destroy tombstone, which is reserved for OPERATOR destroys and
          // would lock the returning visitor out forever (spec violation
          // introduced by add-cell-lifecycle's tombstone rule; found via
          // test-mp-demo 2026-10-30).
          reg(userId, { type: "down", now: Date.now() });
        } else if (cell.state === "stopping") {
          reg(userId, { type: "down", now: Date.now() });
        } else {
          // Unexpected exit: not a destroy — the standing order stays,
          // presence only degrades. Next demand re-binds.
          reg(userId, { type: "down", now: Date.now() });
        }
        if (cell.state === "stopping") {
          cells.delete(userId);
          return;
        }
        cell.state = "error";
        cell.error = `exited (code=${code} signal=${signal})`;
        cell.child = null;
        console.error(`[gateway] cell ${userId} exited unexpectedly: ${cell.error}`);
        // Crash ledger: this line used to be the ONLY trace, so "is this cell
        // stable?" died with the process. Persist the scene (code/signal/at/
        // uptime) and the count; a crash is NOT a lifecycle transition, so the
        // row's state/holder semantics stay untouched.
        if (registryDb) {
          try {
            const row = registryRowForSafe(userId);
            if (row) {
              const at = Date.now();
              const uptimeMs = cell.startedAt ? Math.max(0, at - cell.startedAt) : null;
              registryDb.put({
                ...row,
                crashCount: Number(row.crashCount ?? 0) + 1,
                lastCrash: { code: code ?? null, signal: signal ?? null, at, uptimeMs, message: cell.error },
              });
            }
          } catch (e) {
            console.warn(`[gateway] crash ledger write failed for ${userId}: ${e?.message || e}`);
          }
        }
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
        reg(userId, { type: "bindFailed", now: Date.now() });
        // Startup failure is its own counter: "came up but never listened" is a
        // different cause from "crashed while running", and the two must not be
        // summed into one scary number.
        if (registryDb) {
          try {
            const row = registryRowForSafe(userId);
            if (row) {
              registryDb.put({
                ...row,
                bindFailureCount: Number(row.bindFailureCount ?? 0) + 1,
                lastBindFailure: { at: Date.now(), message: err.message, timeoutMs: startTimeoutMs },
              });
            }
          } catch (e) {
            console.warn(`[gateway] bind-failure ledger write failed for ${userId}: ${e?.message || e}`);
          }
        }
        throw err;
      }
      cell.state = "running";
      // The idle clock starts when the cell STARTS SERVING, not when it was
      // forked: a cold boot takes ~8-12s (startTimeoutMs), and aging the cell by
      // its own boot meant that with a short reap window the reaper SIGTERMed it
      // before the dsh runtime was ready — so no session was ever created and no
      // connect-time sync could be sent. The demand that spawned the cell is, by
      // definition, its first traffic.
      cell.lastTraffic = Date.now();
      reg(userId, { type: "up", now: Date.now() });
      // Rehabilitation (add-cell-crash-ledger): a crash count that never resets
      // would keep reporting a defect the deploy already fixed. Once the cell
      // has been running longer than the rehab window, clear the COUNT but keep
      // the last scene — the history stays readable, the alarm does not.
      if (registryDb && crashRehabMs > 0) {
        const rehabTimer = setTimeout(() => {
          try {
            const row = registryRowForSafe(userId);
            if (!row || !(Number(row.crashCount ?? 0) > 0)) return;
            if (cells.get(userId) !== cell || cell.state !== "running") return;
            if (Date.now() - (cell.startedAt ?? 0) < crashRehabMs) return;
            registryDb.put({ ...row, crashCount: 0 });
            console.log(`[gateway] cell ${userId} rehabilitated (crash count reset, last scene kept)`);
          } catch (e) {
            console.warn(`[gateway] crash-ledger rehab failed for ${userId}: ${e?.message || e}`);
          }
        }, crashRehabMs);
        rehabTimer.unref?.();
      }
      console.log(`[gateway] cell ${userId} running on 127.0.0.1:${port} (pid ${cell.pid})`);
      return cell;
    })();
  }

  // ── Memory admission gate (harden-platform-memory-carrier 2.x) ────────────
  //
  // New residency (spawn on traffic, wake from suspension — every residency
  // passes ensure()) checks container headroom BEFORE a process is spawned
  // into an out-of-memory window. Fail-open is the contract: metrics missing
  // or malformed admit with a warning, never block business. Already-resident
  // cells never see this gate — it runs on the spawn path only, so the gate
  // cannot evict anyone.
  function recordGateRefusal(cellId, user, verdict, { footprintBytes = null, evictedCellIds = [], inflightBytes = 0, defaultFootprintApplied = false } = {}) {
    console.warn(
      `[gateway] cell residency refused (memory floor): user=${user.email} ` +
        `used=${verdict.usedBytes} limit=${verdict.limitBytes} ` +
        `headroom=${(verdict.headroomPct * 100).toFixed(1)}% threshold=${(verdict.threshold * 100).toFixed(1)}%` +
        (verdict.projectedBytes != null ? ` projected=${verdict.projectedBytes}` : "") +
        (footprintBytes != null ? ` footprint=${footprintBytes}` : "") +
        (defaultFootprintApplied ? ` defaultFootprint=true` : "") +
        (inflightBytes > 0 ? ` inflight=${inflightBytes}` : "") +
        (evictedCellIds.length > 0 ? ` evicted=${evictedCellIds.join(",")}` : ""),
    );
    if (!registryDb) return;
    try {
      let row = registryDb.get(cellId);
      if (!row) {
        // First contact refused: materialize the row (unbound, like a never-
        // bound cell) so the refusal has a durable place to live.
        const demo = Boolean(user.groups?.includes?.("demo"));
        registryDb.fire(cellId, { type: "register", ownerEmail: user.email, now: Date.now() }, { policy: demo ? "ephemeral" : initialPolicy });
        row = registryDb.get(cellId);
      }
      if (row) {
        registryDb.put({
          ...row,
          lastGateRefusal: {
            usedBytes: verdict.usedBytes,
            limitBytes: verdict.limitBytes,
            headroomPct: verdict.headroomPct,
            threshold: verdict.threshold,
            ...(verdict.projectedBytes != null ? { projectedBytes: verdict.projectedBytes } : {}),
            ...(footprintBytes != null ? { footprintBytes } : {}),
            ...(inflightBytes > 0 ? { inflightBytes } : {}),
            ...(defaultFootprintApplied ? { defaultFootprintApplied: true } : {}),
            ...(evictedCellIds.length > 0 ? { evictedCellIds } : {}),
            at: Date.now(),
          },
        });
      }
    } catch (e) {
      console.warn(`[gateway] gate refusal evidence write failed for ${cellId}: ${e?.message || e}`);
    }
  }

  // null = admission granted (or the gate is inert); a refuse verdict otherwise.
  // projectedBytes (harden-cell-wake-admission): this wake's OWN contribution —
  // its archived footprint, or the conservative default when no archive exists.
  // inflightBytes (add-wake-budget-admission): OTHER wakes' reservation sum —
  // the verdict judges current + others + own, so concurrent wakes cannot
  // overshoot the floor on one shared pre-wake snapshot. `usingDefault` marks
  // evidence where the conservative default stood in for a missing archive.
  function memoryAdmissionVerdict({ projectedBytes = null, inflightBytes = 0, usingDefault = false } = {}) {
    if (!procMemory || !(memoryFloor > 0)) return null; // gate disabled → legacy
    let verdict;
    try {
      verdict = procMemory.admission(memoryFloor, { projectedBytes, inflightBytes });
    } catch (e) {
      console.warn(`[gateway] memory gate sampler failed; failing open: ${e?.message || e}`);
      return null;
    }
    if (verdict.decision === "fail_open") {
      console.warn(`[gateway] memory gate metrics unavailable (${verdict.reason}); failing open`);
      return null;
    }
    if (verdict.decision === "allow") return null;
    return usingDefault ? { ...verdict, usingDefault } : verdict;
  }

  // ── Wake projection (harden-cell-wake-admission 1.2) ──────────────────────
  // Archive the cell's memory contribution while its process tree is still
  // measurable: the per-cell grouped total (RSS-nominal) calibrated into its
  // cgroup-real contribution by the pod-level RSS→cgroup ratio. A raw nominal
  // sum would permanently oversell the wake (shared pages count once per
  // container, once per process); calibration absorbs that gap. No readable
  // cell group, no container metrics, or a dead process tree → no archive
  // (the next wake degrades to current-only admission, spec's honest path).
  function archiveFootprint(userId) {
    if (!procMemory || !registryDb || typeof procMemory.sample !== "function") return;
    try {
      const snap = procMemory.sample();
      if (!snap?.available) return;
      const cellRow = (snap.cells ?? []).find((c) => c.cellId === userId);
      if (!cellRow || !(cellRow.totalBytes > 0)) return; // processes gone — keep any prior archive
      const container = snap.container;
      const totalScan =
        (snap.cells ?? []).reduce((s, c) => s + c.totalBytes, 0) +
        (snap.gateway?.totalBytes ?? 0) +
        (snap.ungrouped?.totalBytes ?? 0);
      let footprint = null;
      if (container?.available && Number.isFinite(container.usedBytes) && container.usedBytes > 0 && totalScan > 0) {
        const ratio = Math.min(1, Math.max(0, container.usedBytes / totalScan));
        footprint = Math.round(cellRow.totalBytes * ratio);
      }
      if (!(footprint > 0)) return;
      const row = registryRowForSafe(userId);
      if (!row) return;
      registryDb.put({ ...row, lastFootprintBytes: footprint, lastFootprintAt: Date.now() });
    } catch (e) {
      console.warn(`[gateway] footprint archive failed for ${userId}: ${e?.message || e}`);
    }
  }

  // ── Eviction chain (harden-cell-wake-admission 3.x) ───────────────────────
  // A wake whose projection exceeds the floor parks idle residents (the same
  // cells the reaper would park, chosen by the same idle windows and the same
  // policy tier) one at a time — re-projecting after each — until the wake
  // fits. Active residents are never candidates; a candidate that fails to
  // park is skipped, not fatal. The waking cell keeps its parked state until
  // admission actually grants it. Re-projections count OTHER wakes' in-flight
  // reservations (add-wake-budget-admission) — the waking cell's own booking
  // stays in the ledger throughout and is excluded as its own contribution.
  async function evictUntilAdmissible(wakingUserId, ownBytes, usingDefault = false) {
    const now = Date.now();
    const candidates = [];
    for (const cell of [...cells.values()]) {
      if (cell.state !== "running" || cell.userId === wakingUserId) continue;
      if (cell.child?.exitCode !== null) continue; // already dying/dead — nothing to free
      if ((registryRowForSafe(cell.userId)?.policy ?? initialPolicy) === "always") continue;
      const windowSecs = cell.demo ? demoIdleReapSecs : idleReapSecs;
      if (!(windowSecs > 0)) continue; // no idle definition on this tier → untouchable
      const lastActive = Math.max(cell.lastTraffic ?? 0, registryRowForSafe(cell.userId)?.lastUserTrafficAt ?? 0);
      if (lastActive > now - windowSecs * 1000) continue; // active within the reap window
      candidates.push({ cell, idleMs: now - lastActive });
    }
    candidates.sort((a, b) => b.idleMs - a.idleMs); // idle-most first (spec: 驱逐闲置最久者)
    const evicted = [];
    for (const { cell, idleMs } of candidates) {
      try {
        console.log(`[gateway] memory admission evicting idle resident ${cell.userId} (idle ${Math.round(idleMs / 1000)}s)`);
        stop(cell.userId, "memory admission eviction");
        await terminateChild(cell.child, cell.userId); // exit handler parks the row (durable truth)
      } catch (e) {
        console.warn(`[gateway] memory admission eviction failed for ${cell.userId}: ${e?.message || e}`);
        continue;
      }
      evicted.push(cell.userId);
      procMemory.clearCache?.(); // post-park water, not a TTL-stale high one
      const verdict = memoryAdmissionVerdict({
        projectedBytes: ownBytes > 0 ? ownBytes : null,
        inflightBytes: inflightBytesExcluding(wakingUserId),
        usingDefault,
      });
      if (!verdict) return { evicted, refusal: null }; // fits (or fail-open admits)
    }
    return {
      evicted,
      refusal: memoryAdmissionVerdict({
        projectedBytes: ownBytes > 0 ? ownBytes : null,
        inflightBytes: inflightBytesExcluding(wakingUserId),
        usingDefault,
      }),
    };
  }

  // Concurrent first requests for the same user collapse onto one spawn. The
  // in-flight promise is registered BEFORE spawnCell() runs: spawnCell awaits a
  // free port and three mkdirs before it writes the cell record, so any guard
  // reading the record (cells.get(userId).starting) misses exactly the window
  // two parallel requests would both observe.
  function ensure(user) {
    const userId = userIdFor(user.email);
    // Tombstone suppression (add-cell-lifecycle 3.3): a destroyed cell never
    // re-binds on traffic — the standing order is dead until an operator
    // explicitly clears the row.
    const tomb = registryRowForSafe(userId);
    if (tomb?.destroy || tomb?.state === "destroyed") {
      const err = new Error("cell destroyed");
      err.code = "cell_destroyed";
      return Promise.reject(err);
    }
    const existing = cells.get(userId);
    if (existing && existing.state === "running") {
      existing.lastTraffic = Date.now();
      if (registryDb) {
        const row = tomb ?? newRegistryRow({ cellId: userId, ownerEmail: user.email });
        registryDb.put({ ...row, ownerEmail: row.ownerEmail ?? user.email, lastUserTrafficAt: Date.now() });
      }
      return Promise.resolve(existing);
    }
    const pending = inflight.get(userId);
    if (pending) {
      // A request that collapses onto an in-flight spawn is STILL traffic — it
      // is the demand that will use the cell once it is up. Returning without
      // refreshing the idle clock let a cold cell be aged by its own boot, and
      // with a short reap window it was stopped mid-boot: every queued waiter
      // then retried into a fresh spawn, which is a cold-start loop (observed as
      // a single test run taking 986s). Resolved asynchronously so this branch
      // stays a plain return; the refresh lands when the spawn materializes.
      Promise.resolve(pending).then(
        () => {
          const settled = cells.get(userId);
          if (settled?.state === "running") settled.lastTraffic = Date.now();
        },
        () => {},
      );
      return pending;
    }
    // Demo pool bound (openspec: mp-demo-mode): a full pool is an expected,
    // friendly condition, so the error carries a machine-readable code and a
    // user-facing message rather than a raw spawn failure.
    if (user.groups?.includes?.("demo") && runningDemoCount() >= demoMaxCells) {
      const err = new Error("demo capacity reached");
      err.code = "demo_capacity";
      err.friendly = "当前体验人数较多，请稍后再试";
      return Promise.reject(err);
    }
    // Memory admission gate (harden-cell-wake-admission): a wake with an
    // archived footprint is judged on the PROJECTED steady state — the
    // 2026-11-04 OOM window was invisible to current-only admission.
    // add-wake-budget-admission: the wake's OWN contribution (archive, else
    // the conservative default) is booked into the reservation ledger BEFORE
    // the verdict, so concurrent wakes inside one sampling window judge
    // current + Σ(others' reservations) + own instead of one shared pre-wake
    // snapshot. Projection short → idle residents are evicted (parked, state
    // on disk) one at a time with a re-projection each; still short → refused
    // BEFORE any process materializes. The reservation is released when the
    // residency settles (materialized or failed) — never leaks; fail-open and
    // gate-disabled paths skip the ledger entirely (byte-for-byte legacy).
    // The inflight claim below stays SYNCHRONOUS with the pending check —
    // no await may slip between them (2026-10-10 duplicate-spawn guard).
    // Freshness (fix-stale-wake-footprint): an archive older than the TTL is
    // treated as absent — the wake is then judged on the default footprint,
    // which is the same path a never-before-measured cell takes. A legacy row
    // with bytes but no stamp is treated as stale (the stamp ships with this
    // change; anything older predates it).
    // The stamp ships with this change, so legacy rows have bytes but no
    // `lastFootprintAt`. `updatedAt` is the fallback: `put()` touches it on the
    // same park that wrote the footprint, so it is the same instant for any row
    // this archive has ever written — and a row whose updatedAt is ancient is
    // exactly the stale high-water mark we want to retire.
    // `updatedAt` is deliberately NOT a fallback: `put()` rewrites it on every
    // write, so it says "someone touched this row", not "when was this measured".
    // A row carrying bytes but no stamp predates freshness tracking, and its age
    // is unknowable — treat it as stale so the cell gets one re-measure instead
    // of staying dark forever.
    const archivedAt = Number.isFinite(tomb?.lastFootprintAt) ? tomb.lastFootprintAt : null;
    // ttl <= 0 disables expiry (an archive is then always authoritative).
    const footprintFresh =
      archivedAt !== null && (footprintTtlMs <= 0 || Date.now() - archivedAt <= footprintTtlMs);
    const wakeFootprint = (() => {
      const fp = tomb?.lastFootprintBytes;
      if (!(Number.isFinite(fp) && fp > 0)) return null;
      return footprintFresh ? fp : null; // stale ⇒ absent ⇒ default footprint
    })();
    if (archivedAt !== null && !footprintFresh) {
      console.log(`[gateway] cell ${userId} archived footprint ${Math.round((tomb.lastFootprintBytes ?? 0) / 1e6)}MB is stale (age ${Math.round((Date.now() - archivedAt) / 60000)}min) — judging the wake on the ${Math.round(defaultFootprintBytes / 1e6)}MB default`);
    }
    const armed = gateArmed();
    const ownBytes = armed ? (wakeFootprint ?? defaultFootprintBytes) : 0;
    const usingDefault = armed && wakeFootprint == null && ownBytes > 0;
    const started = (async () => {
      if (armed && ownBytes > 0) inflightWakes.set(userId, ownBytes);
      try {
        let refusal = armed
          ? memoryAdmissionVerdict({
              projectedBytes: ownBytes > 0 ? ownBytes : null,
              inflightBytes: inflightBytesExcluding(userId),
              usingDefault,
            })
          : null;
        let evicted = [];
        if (refusal?.decision === "refuse" && ownBytes > 0) {
          ({ evicted, refusal } = await evictUntilAdmissible(userId, ownBytes, usingDefault));
        }
        if (refusal) {
          // Diagnostic (fix-stale-wake-footprint): would the DEFAULT footprint have
          // fit? When this is true the refusal is being carried by the archive, not
          // by the container — the operator can free memory or wait for the TTL
          // instead of chasing a phantom "the cell needs 2GB".
          const defaultVerdict = wakeFootprint !== null && wakeFootprint !== defaultFootprintBytes
            ? memoryAdmissionVerdict({ projectedBytes: defaultFootprintBytes, inflightBytes: inflightBytesExcluding(userId), usingDefault: true })
            : null;
          const defaultWouldFit = defaultVerdict ? defaultVerdict.decision !== "refuse" : null;
          if (defaultWouldFit === true) {
            console.warn(`[gateway] cell ${userId} refused on an archived footprint of ${Math.round(wakeFootprint / 1e6)}MB while a ${Math.round(defaultFootprintBytes / 1e6)}MB default would fit — the archive is the blocker`);
          }
          recordGateRefusal(userId, user, { ...refusal, defaultWouldFit }, { footprintBytes: wakeFootprint, evictedCellIds: evicted, inflightBytes: inflightBytesExcluding(userId), defaultFootprintApplied: usingDefault });
          const err = new Error("cell residency refused: container memory headroom below floor");
          err.code = "memory_floor";
          err.friendly = "服务器内存余量不足，请稍后再试";
          err.memory = {
            usedBytes: refusal.usedBytes,
            limitBytes: refusal.limitBytes,
            headroomPct: refusal.headroomPct,
            threshold: refusal.threshold,
            ...(refusal.projectedBytes != null ? { projectedBytes: refusal.projectedBytes } : {}),
            ...(wakeFootprint != null ? { footprintBytes: wakeFootprint } : {}),
            ...(inflightBytesExcluding(userId) > 0 ? { inflightBytes: inflightBytesExcluding(userId) } : {}),
            ...(usingDefault ? { defaultFootprintApplied: true } : {}),
            evictedCellIds: evicted,
          };
          throw err;
        }
        // Crash backoff: pay the delay BEFORE a process exists, so a crash
        // loop costs one spawn per delay instead of a fork bomb. Never a
        // refusal — the wake still happens, just later.
        const backoff = crashDelayMs(registryRowForSafe(userId));
        if (backoff > 0) {
          console.warn(
            `[gateway] cell ${userId} crashed recently (count ${registryRowForSafe(userId)?.crashCount ?? 0}); ` +
              `delaying respawn by ${backoff}ms (window ${Math.round(crashWindowMs / 1000)}s)`,
          );
          await new Promise((r) => setTimeout(r, backoff));
        }
        return await spawnCell(user); // await: the finally below must fire on SETTLE, not on return — the reservation covers materialization
      } finally {
        if (armed) inflightWakes.delete(userId);
      }
    })().finally(() => {
      inflight.delete(userId);
    });
    inflight.set(userId, started);
    return started;
  }

  function stop(userId, reason) {
    const cell = cells.get(userId);
    if (!cell) return false;
    // Footprint archive (harden-cell-wake-admission): sample while the process
    // tree is still measurable — first stop wins, a dying tree reads as gone.
    if (cell.state !== "stopping" && cell.child && cell.child.exitCode === null) archiveFootprint(userId);
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
      // An attached WebSocket is live traffic the reaper cannot otherwise see:
      // it produces no HTTP ensure() calls, so a chat sitting on its socket
      // reads as idle. Without this, a turn longer than the window was killed
      // mid-stream even after the boot-clock fix above.
      if (isActive?.(cell.userId)) continue;
      // Residency policy governs reaping (3.4 transition bridge):
      //   always      never reaped (the explicit-resident tier)
      //   on_demand   reaped on quiet — NO scheduled-work exemption: the duty
      //               ring owns its resumption now, suspension is no longer a
      //               schedule miss. The legacy branch (no registryDb) keeps
      //               the exemption byte-for-byte.
      if (registryDb) {
        const policy = (registryRowForSafe(cell.userId)?.policy ?? initialPolicy);
        if (policy === "always") continue;
        stop(cell.userId, "idle (on_demand)");
        continue;
      }
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
      ...(registryDb ? { registry: (registryRowForSafe(cell.userId)?.state ?? null), policy: (registryRowForSafe(cell.userId)?.policy ?? null) } : {}),
    }));
  }

  // Disk figures ride a SEPARATE async view: measuring 48 cell roots is I/O the
  // sync status() must not hide behind (budget-cell-disk-usage 2.1). The readings
  // are TTL-cached, so a polling console costs one walk per cell per window.
  const diskMeter = createDiskMeter();

  async function statusWithDisk() {
    const base = status();
    return Promise.all(
      base.map(async (cell) => {
        try {
          const disk = await diskMeter.read(path.join(dataRoot, cell.userId));
          return { ...cell, disk };
        } catch (e) {
          // A cell whose bytes cannot be read still appears — with the error,
          // never silently missing from the board.
          return { ...cell, disk: null, diskError: e?.message || String(e) };
        }
      }),
    );
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
    // Every non-destroyed row parks as `suspended` across the roll — the duty
    // ring rebuilds obligations from persistence on the next boot (3.1 spec).
    if (registryDb) {
      for (const row of registryDb.all()) {
        if (row.destroy || row.state === "destroyed") continue;
        reg(row.cellId, { type: "down", now: Date.now() });
      }
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

  return { ensure, record, status, statusWithDisk, diskMeter, stop, drop, shutdown, cells, reapIdle };
}
