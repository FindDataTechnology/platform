// ── Shared test-server process hygiene (fix-unit-lane-process-hygiene) ───────
//
// One implementation for both test lanes (Playwright e2e specs via
// e2e/helpers.js and node --test scripts via scripts/test-*.mjs). Every dsh
// orphan incident has the same shape: a test kills only the process it spawned
// — sometimes the very process responsible for reaping the dsh children — and
// the survivors are reparented to launchd where they burn kernel CPU forever.
//
// Four mechanisms, one contract (specs/test-process-hygiene):
//
//   1. group ownership — servers spawn `detached`, i.e. as their own
//      process-group leader; every descendant they will ever spawn (dsh cells,
//      worker bridges, stubs) inherits that group, so one group signal reaches
//      the whole tree;
//   2. owner teardown ladder — stop() SIGTERMs the group, waits a bounded
//      grace (20s, the bridge's documented worst-case ladder is ~14s), then
//      group-SIGKILLs stragglers. Escalation NEVER targets a lone PID.
//   3. ownership registration — before the server can spawn children, the
//      group is registered under $TMPDIR/paas-test-servers/<pgid>.json with
//      its owner and optional throwaway store root;
//   4. self-healing sweep — on module import, registrations whose owner is
//      dead are group-SIGKILLed and their store roots deleted. A script that
//      is itself SIGKILLed (hooks can't run) is thus cleaned by the next test
//      run, no operator action. Registrations with a live owner are never
//      touched, so concurrent runs are safe.
//
// Owner-process hooks (installed on first use) close the remaining exits:
// normal exit, assertion failure, SIGINT, SIGTERM all force-kill every group
// the process registered — without relying on the script's finally blocks.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The teardown ladder's grace. Generous on purpose: a legitimate slow stop
// (bridge RPC + EOF ladder, trace vacuum) must never be mistaken for a wedge.
export const GRACE_MS = 20_000;
const TAIL_MS = 250;

const REGISTRY_DIR = path.join(tmpdir(), "paas-test-servers");

// Groups this process spawned and has not yet torn down. The exit/signal
// hooks force-kill these if the script dies before stop() runs.
const liveServerGroups = new Set();

function killServerGroup(pid, signal) {
  // Negative pid = the process group. ESRCH once the group is fully gone.
  try {
    process.kill(-pid, signal);
  } catch { /* already gone */ }
}

function entryPath(pgid) {
  return path.join(REGISTRY_DIR, `${pgid}.json`);
}

function registerGroup(pgid, storeRoot) {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(entryPath(pgid), JSON.stringify({
    pgid,
    ownerPid: process.pid,
    storeRoot: storeRoot ?? null,
    createdAt: Date.now(),
  }));
}

function deregisterGroup(pgid) {
  try { unlinkSync(entryPath(pgid)); } catch { /* already gone */ }
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the pid exists but belongs to someone else — still alive, skip.
    return err.code !== "ESRCH";
  }
}

// One ps table of { pgid -> [commands] } for the identity gate below. Group
// ids are recycled like pids, so a stale registration's pgid may now belong to
// an unrelated process group. A group is only killable when every member's
// command line names this repo — our spawned trees always do (node <repo>/…),
// foreign ones never do.
function processGroups() {
  const out = execFileSync("ps", ["-axo", "pgid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const groups = new Map();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const list = groups.get(Number(m[1])) ?? [];
    list.push(m[2]);
    groups.set(Number(m[1]), list);
  }
  return groups;
}

// Sweep stale registrations: owner dead → group SIGKILL + store root deleted.
// Runs at import so ANY later test run (either lane) heals a previous run's
// SIGKILLed corpses. Owner alive → skip (a recycled owner pid may delay a
// corpse's cleanup by one run, never kills a live run's servers).
export function sweepStaleServers() {
  if (!existsSync(REGISTRY_DIR)) return;
  let groups = null;
  for (const name of readdirSync(REGISTRY_DIR)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(REGISTRY_DIR, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      try { unlinkSync(file); } catch { /* raced */ } // corrupt entry is garbage
      continue;
    }
    if (!entry?.pgid || ownerAlive(entry.ownerPid)) continue;
    if (entry.storeRoot) rmSync(entry.storeRoot, { recursive: true, force: true });
    groups ??= processGroups();
    const members = groups.get(entry.pgid) ?? [];
    // Empty group: nothing to kill. Non-empty but with a member that doesn't
    // name this repo: identity unprovable — never kill, just drop the entry.
    if (members.every((cmd) => cmd.includes(REPO_ROOT))) {
      killServerGroup(entry.pgid, "SIGKILL");
    }
    try { unlinkSync(file); } catch { /* raced */ }
  }
}

let hooksInstalled = false;
function installOwnerHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // 'exit' doesn't fire for signals the process doesn't handle, so hook the
  // signals too and exit explicitly after the sweep. This path is the last
  // resort — it force-kills; graceful teardown is stop()'s job.
  const collect = (ev) => {
    for (const pid of liveServerGroups) {
      killServerGroup(pid, "SIGKILL");
      deregisterGroup(pid);
    }
    if (ev !== "exit") process.exit(ev === "SIGINT" ? 130 : 143);
  };
  for (const ev of ["exit", "SIGINT", "SIGTERM"]) process.on(ev, () => collect(ev));
}

try {
  sweepStaleServers();
} catch (err) {
  // A failed sweep must never break the importing test run — the ladder and
  // hooks above still hold; the corpses wait for the next attempt.
  console.warn(`[test-server] stale sweep failed: ${err.message}`);
}

export function spawnTestServer({
  env,
  cwd = process.cwd(),
  args = ["server.js"],
  execPath = process.execPath,
  // Throwaway data root to delete when this group is swept as a corpse.
  storeRoot = null,
  // Overridable for scripts whose servers log to stderr only — a piped stdout
  // with no listener fills its 64k buffer and wedges the server.
  stdio = ["ignore", "pipe", "pipe"],
} = {}) {
  installOwnerHooks();
  const child = spawn(execPath, args, {
    cwd,
    env,
    stdio,
    detached: true,
  });
  liveServerGroups.add(child.pid);
  registerGroup(child.pid, storeRoot);
  const isDown = () => child.exitCode !== null || child.signalCode !== null;

  return {
    child,
    // Graceful-then-forced teardown of the whole tree. The default grace
    // exceeds the bridge's worst-case shutdown ladder (5s RPC + 6s EOF +
    // 3s SIGTERM ≈ 14s), so the SIGKILL only ever lands on a genuinely
    // wedged process.
    stop: async ({ graceMs = GRACE_MS } = {}) => {
      if (child.pid) {
        killServerGroup(child.pid, "SIGTERM");
        const deadline = Date.now() + graceMs;
        while (!isDown() && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        killServerGroup(child.pid, "SIGKILL");
        liveServerGroups.delete(child.pid);
        deregisterGroup(child.pid);
        // A reaped-a-beat-late dsh can still hold store files for an instant;
        // give spec teardowns that rmSync their temp roots a moment to win.
        await new Promise((r) => setTimeout(r, TAIL_MS));
      }
    },
  };
}
