// Playwright globalTeardown: sweep leaked e2e processes, then remove the
// throwaway store directories created at config load time (see e2e/helpers.js).
//
// The sweep is the last line of defense against dsh orphans. Specs kill their
// spawned servers via spawnTestServer()'s group kill (now shared with the unit
// lane in scripts/lib/test-server.mjs, which also owns-registers and
// self-heals stale entries), and the worker-exit hooks force-kill on worker
// death — but a worker that is itself SIGKILLed (Ctrl-C abort, crash) skips
// those. Anything left at global teardown with an e2e marker in its command
// line is garbage by definition.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempStoreDirs } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// dsh as actually spawned in this repo: node <repo>/node_modules/@deepseek-ai/
// dsh/lib/bin.js --profile … (plus the DSH_BIN "bin/dsh" layout for completeness).
const DSH_CMD = /(dsh\/lib\/bin\.js|bin\/dsh)\b.*--profile/;

// Markers that only ever appear in a throwaway e2e/rehearsal context: the
// per-port store root (.e2e-store-3100) and the spec mkdtemp prefixes, both of
// which ride the dsh child's --patch argv. A concurrently-running e2e process
// with a LIVE parent is never an orphan, so the PPID=1 gate keeps a parallel
// run's processes untouched.
const E2E_MARKER = /\.e2e-store-\d+\/|paas-[a-z0-9-]*-e2e-|migrate-rehearsal-|app-pair-smoke-/;

function processTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return rows;
}

function cwdOf(pid) {
  try {
    const out = execFileSync("lsof", ["-a", `-p${pid}`, "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/^n(.+)$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function sweepLeakedE2eProcesses() {
  let rows;
  try {
    rows = processTable();
  } catch {
    return; // no ps, no sweep — the group kills above remain the primary path
  }

  const victims = [];
  const orphanedByDeath = new Set();

  for (const row of rows) {
    if (row.ppid !== 1 || !DSH_CMD.test(row.cmd) || !E2E_MARKER.test(row.cmd)) continue;
    victims.push(row);
    orphanedByDeath.add(row.pid);
  }

  // A worker dying before afterAll leaves the SPEC's server.js alive as an
  // orphan (PPID=1) with its dsh children still attached — the dsh rows above
  // don't catch those (their parent is alive). Sweep such servers too: an
  // orphaned `node server.js` whose cwd is this repo AND which parents a
  // marked dsh child is unambiguously a leaked e2e server. A real dev server
  // runs under a terminal/launcher parent, so it never matches.
  for (const row of rows) {
    if (row.ppid !== 1 || !/(^|\s)server\.js\s*$/.test(row.cmd) || !row.cmd.includes("node")) continue;
    const hasMarkedChild = rows.some((r) => r.ppid === row.pid && DSH_CMD.test(r.cmd) && E2E_MARKER.test(r.cmd));
    if (!hasMarkedChild) continue;
    const cwd = cwdOf(row.pid);
    if (cwd && (cwd === REPO_ROOT || cwd.startsWith(`${REPO_ROOT}${path.sep}`))) {
      victims.push(row);
      // Its dsh children die with it; collect them so the log is complete.
      for (const r of rows) {
        if (r.ppid === row.pid && DSH_CMD.test(r.cmd)) victims.push(r);
      }
    }
  }

  for (const v of victims) {
    try {
      process.kill(v.pid, "SIGKILL");
      console.log(`[teardown] swept leaked e2e process pid=${v.pid}: ${v.cmd.slice(0, 120)}`);
    } catch { /* raced away */ }
  }
  if (victims.length) {
    // Give the kernel a beat to reap before the store dirs are deleted.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

export default async function globalTeardown() {
  sweepLeakedE2eProcesses();
  cleanupTempStoreDirs();
}
