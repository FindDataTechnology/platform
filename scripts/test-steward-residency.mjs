// Unit tests — desktop residency hardening (add-desktop-residency-hardening).
// Run: node --test scripts/test-steward-residency.mjs
//
//  1.x  registration artifacts: the plan is ASSERTABLE as data on both
//       platforms (mac plist fields, Windows schtasks argv) — CI must not
//       depend on launchctl/schtasks behaviour.
//  2.x  crash-loop guard: consecutive failed boots count, the threshold opens
//       a cooldown (the stack stays dark), a healthy boot clears the history,
//       and an explicit action clears it immediately.
//  3.x  convergence: a resident boot prunes orphan deployments and reports
//       what it restored/pruned; an empty deployment set is a HEALTHY state.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "steward-residency-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const { createCrashGuard, CRASH_DEFAULTS } = await import("../supervisor/steward-health.js");
const { registrationArtifacts, schtasksCreateArgs, WIN_TASK_NAME } = await import("../electron/steward-install.js");
const feed = await import("../server/local-agent-feed.js");

test("1.1 Windows registration is assertable data (schtasks argv)", () => {
  const artifacts = registrationArtifacts({
    platform: "win32",
    nodeBin: "C:\\Program Files\\Platform\\node.exe",
    entryPath: "C:\\Program Files\\Platform\\resources\\app\\supervisor\\steward-main.js",
  });
  assert.equal(artifacts.kind, "scheduled-task");
  assert.equal(artifacts.taskName, WIN_TASK_NAME);
  assert.equal(artifacts.trigger, "ONLOGON", "launch-at-login trigger");
  assert.equal(artifacts.runLevel, "LIMITED", "no elevation");
  assert.equal(artifacts.force, true, "/F makes re-registration a replace, not a duplicate");
  assert.ok(artifacts.args.includes("/Create"));
  assert.ok(artifacts.args.join(" ").includes("steward-main.js"), "the stable entry path rides the task");
  // The argv is the same one install() executes.
  assert.deepEqual(artifacts.args, schtasksCreateArgs({
    nodeBin: "C:\\Program Files\\Platform\\node.exe",
    entryPath: "C:\\Program Files\\Platform\\resources\\app\\supervisor\\steward-main.js",
  }));
});

test("1.2 macOS registration is assertable data (plist fields)", () => {
  const artifacts = registrationArtifacts({
    platform: "darwin",
    nodeBin: "/Applications/Platform.app/Contents/Resources/node/bin/node",
    entryPath: "/Applications/Platform.app/Contents/Resources/app/supervisor/steward-main.js",
    logDir: "/tmp/logs",
  });
  assert.equal(artifacts.kind, "launch-agent");
  assert.equal(artifacts.fields.runAtLoad, true, "RunAtLoad — the launch-at-login half");
  assert.equal(artifacts.fields.keepAlive, true, "KeepAlive — the resident half");
  assert.equal(artifacts.fields.keepAliveOnSuccessfulExit, true, "respawn unless the exit was clean");
  assert.ok(artifacts.fields.throttleInterval > 0, "launchd throttles respawns (the guard stops the loop)");
  assert.ok(artifacts.fields.programArguments.some((a) => a.includes("steward-main.js")));
  assert.ok(artifacts.path.endsWith(".steward.plist"));
});

test("2.1 consecutive failures open a cooldown and block the stack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  let clock = 1000;
  const guard = createCrashGuard({
    dataDir: dir,
    threshold: 3,
    cooldownMs: 60_000,
    now: () => clock,
    log: { warn() {} },
  });
  assert.equal(guard.recordStart().allowed, true, "first boot is allowed");

  guard.recordFailure("boom 1");
  guard.recordFailure("boom 2");
  assert.equal(guard.recordStart().allowed, true, "below the threshold the stack still starts");
  guard.recordFailure("boom 3");

  const blocked = guard.recordStart();
  assert.equal(blocked.allowed, false, "the threshold opens the cooldown");
  assert.equal(blocked.reason, "cooldown");
  assert.ok(blocked.retryAfterMs > 0);
  const st = guard.status();
  assert.equal(st.coolingDown, true);
  assert.equal(st.failures, 3);
  assert.match(st.lastFailure.message, /boom 3/);

  // The state survives a process restart (the file is the memory).
  const guard2 = createCrashGuard({ dataDir: dir, threshold: 3, cooldownMs: 60_000, now: () => clock, log: { warn() {} } });
  assert.equal(guard2.recordStart().allowed, false, "the cooldown survives a restart");

  // After the window, the next attempt is allowed again.
  clock += 61_000;
  assert.equal(guard2.recordStart().allowed, true);
});

test("2.2 a healthy boot clears the failure history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  let clock = 1000;
  const guard = createCrashGuard({ dataDir: dir, threshold: 2, cooldownMs: 1000, now: () => clock, log: { warn() {} } });
  guard.recordFailure("bad build");
  assert.equal(guard.status().failures, 1);
  guard.recordHealthy();
  const st = guard.status();
  assert.equal(st.failures, 0);
  assert.equal(st.coolingDown, false);
  assert.ok(st.lastSuccessAt > 0);
});

test("2.3 an explicit action clears the history immediately", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const guard = createCrashGuard({ dataDir: dir, threshold: 1, cooldownMs: 60_000, log: { warn() {} } });
  guard.recordFailure("broken");
  assert.equal(guard.recordStart().allowed, false);
  guard.clear();
  assert.equal(guard.recordStart().allowed, true, "the repair action stands the guard down");
  assert.equal(guard.status().failures, 0);
});

test("2.4 defaults leave room for a slow cold start", () => {
  assert.ok(CRASH_DEFAULTS.threshold >= 3, "a slow dsh cold start must not trip the guard");
  assert.ok(CRASH_DEFAULTS.cooldownMs >= 60_000);
});

test("3.1 convergence prunes orphans and reports the state", () => {
  const manifest = {
    name: "Conv Demo",
    description: "d",
    skills: [],
    agents: [{ id: "worker", name: "Worker", persona: "w", serving: { protocol: "a2a" } }],
  };
  db.upsertInstalledPack({ packId: "conv-pack", name: manifest.name, version: 1, manifest, report: {} });
  feed.deployLocalAgent({ packId: "conv-pack", agentId: "worker", externalRunnerId: null });
  // A deployment whose pack vanished (uninstalled) must not survive.
  db.getDb()
    .prepare(
      `INSERT INTO local_fleet_deployments (agent_path, pack_id, agent_id, enabled, created_at, updated_at)
       VALUES ('packs/ghost/worker', 'ghost-pack', 'worker', 1, ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());

  const report = feed.convergeLocalCluster({ env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.pruned, 1, "the orphan row is pruned");
  assert.equal(report.deployments, 1, "the real deployment stays");
  assert.ok(feed.convergenceReport(), "the report is retained for the status surface");
});

test("3.2 an empty deployment set is a healthy convergence", () => {
  db.getDb().prepare("DELETE FROM local_fleet_deployments").run();
  const report = feed.convergeLocalCluster({ env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.deployments, 0);
  assert.equal(report.enabled, 0);
  assert.equal(report.capacity.used, 0);
});
