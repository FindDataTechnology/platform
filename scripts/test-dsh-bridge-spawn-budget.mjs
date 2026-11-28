#!/usr/bin/env node
// A spawn is bounded in total wall time
// (openspec/changes/fix-catalog-preset-roster-convergence, tasks 5.2/5.3).
//
// Why: `restart()` holds `#restarting` for the whole spawn, and the initialize
// ladder retries the "no adapter" race INIT_RETRIES times. One unlucky ladder
// therefore made EVERY later restart answer "dsh restart already in progress"
// for minutes while `isReady()` stayed false — the state that renders
// "No agent modes are available in this deployment" (2026-11-14 e2e:
// focus-overlay:174, pack-agent-scoping:144). The budget closes that: past it
// the child is abandoned (closed) and the attempt is reported as a failure, so
// the caller's bounded retry gets a turn.
//
// This drives the REAL bridge against a stub runtime it spawns through
// `DSH_BIN` — the assertion is on the bridge's own behaviour (reject, release
// the flag, kill the child), not on a mock of it.
//
// Run: node scripts/test-dsh-bridge-spawn-budget.mjs

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STUB_SOURCE = `#!/usr/bin/env node
// Minimal JSON-RPC runtime stand-in (line-delimited JSON over stdio), driven by
// env: STUB_MODE=no-adapter|ok, STUB_INIT_DELAY_MS, STUB_PID_FILE.
import { writeFileSync } from "node:fs";
const mode = process.env.STUB_MODE || "ok";
const delayMs = Number(process.env.STUB_INIT_DELAY_MS) || 0;
const pidFile = process.env.STUB_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
const write = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const id = msg.id;
    if (typeof id !== "number" && typeof id !== "string") continue;
    if (msg.method === "initialize") {
      if (mode === "silent") continue; // never answers: exercises the per-attempt bound
      const reply = () => {
        if (mode === "no-adapter") {
          write({ jsonrpc: "2.0", id, error: { code: -32603, message: "no adapter registered for provider volces" } });
        } else {
          write({ jsonrpc: "2.0", id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1-stub" } } });
        }
      };
      if (delayMs) setTimeout(reply, delayMs); else reply();
      continue;
    }
    if (msg.method === "platform/capabilities") {
      write({ jsonrpc: "2.0", id, result: { methods: ["preset/set"] } });
      continue;
    }
    if (msg.method === "shutdown") {
      write({ jsonrpc: "2.0", id, result: null });
      setTimeout(() => process.exit(0), 5);
      continue;
    }
    write({ jsonrpc: "2.0", id, result: null });
  }
});
`;

function stubDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-spawn-budget-"));
  const file = path.join(dir, "stub-dsh");
  writeFileSync(file, STUB_SOURCE);
  chmodSync(file, 0o755);
  return file;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The bridge reads its knobs at module load, so the env has to be in place
// BEFORE the import. One import serves all cases: DSH_BIN is per-run, but the
// mode is per-CHILD (the stub reads its own env), so the stub below is chosen
// through a single binary that branches on STUB_MODE.
const BIN = stubDir();
process.env.DSH_BIN = BIN;
process.env.DSH_ROUTE_EXCLUSIVITY = "off";
process.env.DSH_INIT_RETRIES = "50";
// Long enough that the stub's own answer wins the race (a 120ms bound made the
// attempt time out before the child could reply, which is case 4's subject, not
// the ladder's), short enough to keep the suite fast.
process.env.DSH_INIT_TIMEOUT_MS = "1200";
process.env.DSH_SPAWN_BUDGET_MS = "700";
const { DshBridge } = await import("../dsh-bridge.js");

// 1. A ladder that never stops racing is abandoned inside the budget, and the
//    restart flag is released (the old behaviour: ~25s of retries, then the raw
//    adapter error, with every competing restart rejected meanwhile).
{
  process.env.STUB_MODE = "no-adapter";
  const pidFile = path.join(path.dirname(BIN), "pid-1");
  process.env.STUB_PID_FILE = pidFile;
  const bridge = new DshBridge();
  const startedAt = Date.now();
  const err = await bridge.restart({ provider: "volces", model: "stub" }).then(
    () => null,
    (e) => e,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(err, "a child that never takes the handshake must not count as a restart");
  assert.match(err.message, /abandoned after \d+ms \(budget 700ms\)/, `names the budget: ${err.message}`);
  assert.doesNotMatch(err.message, /already in progress/);
  assert.ok(elapsed < 5000, `bounded by the budget, took ${elapsed}ms`);
  assert.equal(bridge.isRestarting(), false, "the flag must be released so the next restart can run");

  // The wedged child is closed rather than leaked (a live half-initialized
  // runtime keeps holding the dsh home).
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0, "the stub ran");
  const deadBy = Date.now() + 3000;
  while (pidAlive(pid) && Date.now() < deadBy) await new Promise((r) => setTimeout(r, 50));
  assert.equal(pidAlive(pid), false, `abandoned child ${pid} must be gone`);

  // And the bridge is still usable: the second attempt fails on the budget
  // again, NOT on "already in progress" (that was the wedge).
  const err2 = await bridge.restart({ provider: "volces", model: "stub" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err2);
  assert.doesNotMatch(err2.message, /already in progress/);
  assert.match(err2.message, /abandoned after/);
  await bridge.shutdown().catch(() => {});
}

// 2. The budget does not break a working spawn: the same path answers ready,
//    the probe runs, and shutdown is clean.
{
  process.env.STUB_MODE = "ok";
  process.env.STUB_INIT_DELAY_MS = "0";
  process.env.STUB_PID_FILE = path.join(path.dirname(BIN), "pid-2");
  const bridge = new DshBridge();
  const res = await bridge.restart({ provider: "volces", model: "stub" });
  assert.equal(res?.serverInfo?.name, "deepseek-harness-sdk-runtime");
  assert.equal(bridge.isReady(), true);
  assert.equal(bridge.hasLiveMethod("preset/set"), true, "the probe must still run inside the budget");
  await bridge.shutdown();
}

// 3. A restart that is genuinely in flight reports its AGE, so a wedged spawn
//    is distinguishable from a two-caller collision in the logs.
{
  process.env.STUB_MODE = "ok";
  process.env.STUB_INIT_DELAY_MS = "800";
  process.env.STUB_PID_FILE = path.join(path.dirname(BIN), "pid-3");
  const bridge = new DshBridge();
  const inflight = bridge.restart({ provider: "volces", model: "stub" });
  await new Promise((r) => setTimeout(r, 100));
  const err = await bridge.restart({ provider: "volces", model: "stub" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "a second restart while one is in flight is still refused");
  assert.match(err.message, /already in progress \(running \d+s\)/, err.message);
  await inflight;
  await bridge.shutdown();
}

// 4. The per-attempt handshake bound is OURS, not the client's default.
//    Regression this pins (2026-11-14): lib/dsh-client-launch.js destructured
//    only {command,args,cwd,env,requestTimeoutMs,shutdownTimeoutMs}, so the
//    `initializeTimeoutMs` the bridge passed was dropped on the floor and a
//    silent child burned the full 60s request timeout — a "restart collided
//    (initialize timed out after 60000ms …)" that also outlived the 45s spawn
//    budget because a plain timeout is not the retryable adapter race.
{
  process.env.STUB_MODE = "silent";
  process.env.STUB_INIT_DELAY_MS = "0";
  process.env.STUB_PID_FILE = path.join(path.dirname(BIN), "pid-4");
  const bridge = new DshBridge();
  const startedAt = Date.now();
  const err = await bridge.restart({ provider: "volces", model: "stub" }).then(
    () => null,
    (e) => e,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(err, "a child that never answers the handshake cannot be a restart");
  assert.match(String(err.message), /initialize timed out/, `the client's own timeout surfaces: ${err.message}`);
  assert.ok(
    elapsed < 3000,
    `the 1200ms per-attempt bound must reach the client (took ${elapsed}ms; 60s means it was dropped)`,
  );
  await bridge.shutdown().catch(() => {});
}

console.log("dsh-bridge spawn budget: 4/4 cases passed");
if (!existsSync(BIN)) throw new Error("stub vanished");
