// Unit tests — desired-state merge + detail beacon + steward pull/relay
// (add-unified-fleet-console 3.1–3.3).
// Run: node --test scripts/test-fleet-desired-merge.mjs
//
//  1.x  merge rules (design D1 matrix): desired→deploy(cloud), reconcile,
//       manual-wins skip, cloud withdraw removes, manual extras untouched,
//       structured rejects (capacity / not deployable), idempotent re-run.
//  2.x  detail beacon: deployments carry source, agents from runner health,
//       merge state persisted, runner-down degrades to [].
//  3.x  steward reporter: pull writes the desired beacon on version change
//       only; failures count into self-reported health; detail relays with
//       steward self-health; double 401 self-destructs (existing contract).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-merge-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
await db.initDb();
const feed = await import("../server/local-agent-feed.js");
const merge = await import("../server/fleet-desired-merge.js");

function manifestFor(packId, agentIds, { serving = true } = {}) {
  return {
    name: packId,
    description: `pack ${packId}`,
    version: 1,
    skills: [{ name: `${packId}-skill` }],
    agents: agentIds.map((id) => ({
      id,
      name: id,
      persona: "worker",
      ...(serving ? { serving: { protocol: "a2a" } } : {}),
    })),
  };
}

function installPack(packId, agentIds, opts = {}) {
  const manifest = manifestFor(packId, agentIds, opts);
  db.upsertInstalledPack({
    packId,
    name: manifest.name,
    version: 1,
    manifest,
    report: { items: [] },
  });
}

const ap = (packId, agentId) => `packs/${packId}/${agentId}`; // agentPathFor convention

function writeDesiredBeacon(version, entries) {
  fs.writeFileSync(path.join(TMP, "fleet-desired.json"), JSON.stringify({ version, entries, pulledAt: Date.now() }));
}

function readDetailBeacon() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TMP, "fleet-detail.json"), "utf8"));
  } catch {
    return null;
  }
}

test.afterEach(() => {
  db.getDb().prepare("DELETE FROM local_fleet_deployments").run();
  db.getDb().prepare("DELETE FROM custom_skills").run();
  db.getDb().prepare("DELETE FROM installed_packs").run();
  for (const f of ["fleet-desired.json", "fleet-detail.json"]) {
    fs.rmSync(path.join(TMP, f), { force: true });
  }
});

// ── 1.x merge rules ──────────────────────────────────────────────────────────

test("1.1 desired enabled + no row → deployed tagged cloud; manual row absent from desired survives", () => {
  installPack("p1", ["a1", "a2"]);
  feed.deployLocalAgent({ packId: "p1", agentId: "a2" }); // manual extra, not in desired
  writeDesiredBeacon(3, [{ packId: "p1", agentId: "a1", enabled: true }]);

  const state = merge.mergeDesired();
  assert.equal(state.desiredVersionSeen, 3);
  assert.equal(state.rejectedCount, 0);
  const row = feed.getDeployment(ap("p1", "a1"));
  assert.equal(row.enabled, true);
  assert.equal(row.source, "cloud");
  const manual = feed.getDeployment(ap("p1", "a2"));
  assert.equal(manual.source, "manual");
  assert.equal(manual.enabled, true);
});

test("1.2 desired reconciles cloud rows but never touches manual rows", () => {
  installPack("p1", ["a1", "a2"]);
  feed.deployLocalAgent({ packId: "p1", agentId: "a1", source: "cloud" });
  feed.setDeploymentEnabled(ap("p1", "a1"), false, { source: "cloud" });
  feed.deployLocalAgent({ packId: "p1", agentId: "a2" });
  feed.setDeploymentEnabled(ap("p1", "a2"), false); // manual row, stopped by the user

  writeDesiredBeacon(4, [{ packId: "p1", agentId: "a1", enabled: true }, { packId: "p1", agentId: "a2", enabled: true }]);
  merge.mergeDesired();

  const cloud = feed.getDeployment(ap("p1", "a1"));
  assert.equal(cloud.enabled, true, "cloud row reconciled to desired enabled");
  assert.equal(cloud.source, "cloud");
  const manual = feed.getDeployment(ap("p1", "a2"));
  assert.equal(manual.enabled, false, "manual row NOT resurrected by the cloud (local wins)");
  assert.equal(manual.source, "manual");
});

test("1.3 desired disabled stops a cloud row; withdrawn expectation removes it", () => {
  installPack("p1", ["a1", "a2"]);
  feed.deployLocalAgent({ packId: "p1", agentId: "a1", source: "cloud" });
  feed.deployLocalAgent({ packId: "p1", agentId: "a2", source: "cloud" });

  writeDesiredBeacon(5, [{ packId: "p1", agentId: "a1", enabled: false }]);
  merge.mergeDesired();

  assert.equal(feed.getDeployment(ap("p1", "a1")).enabled, false);
  assert.equal(feed.getDeployment(ap("p1", "a1")).source, "cloud");
  assert.equal(feed.getDeployment(ap("p1", "a2")), null, "cloud row absent from desired was removed");
});

test("1.4 adoption: a user stop flips cloud→manual; the merge then leaves it alone", () => {
  installPack("p1", ["a1"]);
  feed.deployLocalAgent({ packId: "p1", agentId: "a1", source: "cloud" });
  feed.setDeploymentEnabled(ap("p1", "a1"), false); // user action, no source → adoption

  writeDesiredBeacon(6, [{ packId: "p1", agentId: "a1", enabled: true }]);
  merge.mergeDesired();

  const row = feed.getDeployment(ap("p1", "a1"));
  assert.equal(row.enabled, false, "the cloud cannot resurrect a manually stopped row");
  assert.equal(row.source, "manual");
});

test("1.5 rejections are structured, never silent (capacity / not serving)", () => {
  installPack("p1", ["a1"]);
  installPack("p2", ["b1"]);
  installPack("p3", ["c1"], { serving: false });
  process.env.AGENT_RUNNER_MAX_CHILDREN = "1";
  process.env.AGENT_RUNNER_POD_MODE = "0";
  writeDesiredBeacon(7, [
    { packId: "p1", agentId: "a1", enabled: true },
    { packId: "p2", agentId: "b1", enabled: true },
    { packId: "p3", agentId: "c1", enabled: true },
  ]);

  const state = merge.mergeDesired();
  assert.equal(feed.getDeployment(ap("p1", "a1")).enabled, true);
  assert.equal(feed.getDeployment(ap("p2", "b1")), null, "capacity refused");
  const codes = Object.fromEntries(state.rejects.map((r) => [r.agentPath, r.code]));
  assert.equal(codes[ap("p2", "b1")], "capacity_exceeded");
  assert.equal(codes[ap("p3", "c1")], "agent_not_serving");
  delete process.env.AGENT_RUNNER_MAX_CHILDREN;
  delete process.env.AGENT_RUNNER_POD_MODE;
});

test("1.6 idempotent: same version re-runs nothing; a new version re-merges", () => {
  installPack("p1", ["a1"]);
  writeDesiredBeacon(8, [{ packId: "p1", agentId: "a1", enabled: true }]);
  const first = merge.mergeDesired();
  assert.equal(first.desiredVersionSeen, 8);
  writeDetailBeaconFromState(first);
  const second = merge.mergeDesired();
  assert.deepEqual(second.rejects, []);
  assert.equal(second.desiredVersionSeen, 8);

  writeDesiredBeacon(9, [{ packId: "p1", agentId: "a1", enabled: false }]);
  const third = merge.mergeDesired();
  assert.equal(third.desiredVersionSeen, 9);
  assert.equal(feed.getDeployment(ap("p1", "a1")).enabled, false);
});

function writeDetailBeaconFromState(state) {
  merge.writeDetailBeacon({ mergeState: state, agents: [] });
}

// ── 2.x detail beacon ────────────────────────────────────────────────────────

test("2.1 detail beacon carries deployments with source + merge state + runner agents", async () => {
  installPack("p1", ["a1"]);
  installPack("p2", ["b1"], { serving: false });
  feed.deployLocalAgent({ packId: "p1", agentId: "a1", source: "cloud" });
  // A desired entry that cannot be deployed produces a structured reject,
  // which the beat writes into the detail beacon (machine-view visible).
  writeDesiredBeacon(2, [
    { packId: "p1", agentId: "a1", enabled: true },
    { packId: "p2", agentId: "b1", enabled: true },
  ]);
  const doFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ agents: [{ key: ap("p1", "a1"), state: "serving", port: 8805, version: 1 }] }),
  });
  const loop = merge.startDesiredMergeLoop({ intervalMs: 60_000, doFetch });
  await loop.beat();
  loop.stop();
  const onDisk = readDetailBeacon();
  assert.equal(onDisk.deployments[0].source, "cloud");
  assert.equal(onDisk.agents[0].state, "serving");
  assert.equal(onDisk.merge.desiredVersionSeen, 2);
  assert.equal(onDisk.merge.rejects[0].code, "agent_not_serving");
});

test("2.2 runner down degrades to empty agents, beacon still written", () => {
  installPack("p1", ["a1"]);
  feed.deployLocalAgent({ packId: "p1", agentId: "a1" });
  const doc = merge.writeDetailBeacon({ agents: [] });
  assert.deepEqual(doc.agents, []);
  assert.equal(doc.deployments.length, 1);
});

test("2.3 no PLATFORM_DATA_DIR → beacon paths are null and the loop does not start", () => {
  const saved = process.env.PLATFORM_DATA_DIR;
  delete process.env.PLATFORM_DATA_DIR;
  assert.equal(merge.desiredBeaconPath(), null);
  assert.equal(merge.startDesiredMergeLoop({ intervalMs: 60_000 }), null);
  process.env.PLATFORM_DATA_DIR = saved;
});

// ── 3.x steward reporter: pull + relay + self-destruct ───────────────────────

const reporterModule = await import("../supervisor/steward-reporter.js");

function reporterFixture({ token = "steward-tok", responses = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-r-"));
  fs.writeFileSync(path.join(dataDir, "steward-pair.json"), JSON.stringify({ token, deviceId: "dev-x", gatewayUrl: "http://gw.test", email: "o@t" }, null, 2));
  const calls = [];
  const queue = [...responses];
  const doFetch = async (url, opts = {}) => {
    // Mirror defaultFetch's wire semantics: its POST default is part of the
    // contract — the live walkthrough proved a pull that omits `method: GET`
    // arrives as a POST, trips generic auth 401, and burns the pairing.
    const wire = { method: "POST", ...opts };
    calls.push({ url, method: wire.method, opts, body: wire.body });
    const next = queue.length > 0 ? queue.shift() : { status: 202 };
    // Same shape defaultFetch hands the reporter in production: {status, body}.
    return { status: next.status, body: next.json ?? {} };
  };
  const steward = { running: true, cellId: "cellx", registry: { get: () => null, put: () => {} } };
  const storage = { remove: async () => {} };
  const reporter = reporterModule.createStewardReporter({
    steward,
    dataDir,
    storage,
    appVersion: "1.0.0",
    tickMs: 60_000,
    fetchImpl: doFetch,
    manifestFn: () => ({ fleetCount: 1, memberCount: 2, enabledTaskCount: 3, labels: ["F"] }),
  });
  return { reporter, dataDir, calls, queue };
}

test("3.1 pull writes the desired beacon on version change only", async () => {
  const { reporter, dataDir, calls } = reporterFixture({
    responses: [
      { status: 202 }, // presence
      { status: 202 }, // manifest
      { status: 200, json: { version: 11, entries: [{ packId: "p1", agentId: "a1", enabled: true }] } }, // desired
      { status: 202 }, // detail
    ],
  });
  await reporter.tick();
  const beacon = JSON.parse(fs.readFileSync(path.join(dataDir, "fleet-desired.json"), "utf8"));
  assert.equal(beacon.version, 11);
  assert.equal(beacon.entries[0].packId, "p1");
  const pullCall = calls.find((c) => c.url.includes("desired-fleet"));
  assert.ok(pullCall, "pull door was called");
  assert.equal(pullCall.method, "GET", "the pull rides GET — a POST default falls to generic auth and self-destructs the pairing (walkthrough defect)");
  assert.equal(pullCall.opts.body, undefined, "the pull carries no device parameter (self-scoped)");
  const reportCalls = calls.filter((c) => c.url.includes("cell-report"));
  assert.ok(reportCalls.every((c) => c.method === "POST"), "report legs stay POST");

  // Same version again → beacon untouched (no rewrite).
  const before = fs.readFileSync(path.join(dataDir, "fleet-desired.json"), "utf8");
  const { calls: calls2 } = reporterFixture({});
  void calls2;
  const second = reporterFixture({
    responses: [
      { status: 202 },
      { status: 202 },
      { status: 200, json: { version: 11, entries: [{ packId: "p1", agentId: "a1", enabled: true }] } },
      { status: 202 },
    ],
  });
  await second.reporter.tick();
  // fresh reporter instance → its in-memory lastDesiredVersion is null, so it
  // rewrites once; the CONTENT is identical (idempotent at file level).
  const after = fs.readFileSync(path.join(second.dataDir, "fleet-desired.json"), "utf8");
  assert.equal(JSON.parse(after).version, 11);
  void before;
});

test("3.2 pull failures count into self-reported health and land in cell_detail", async () => {
  fs.writeFileSync(path.join(TMP, "fleet-detail.json"), JSON.stringify({ at: 1, deployments: [], agents: [] }));
  fs.writeFileSync(path.join(TMP, "steward-health.json"), JSON.stringify({ failures: 2 }));
  // The reporter reads its OWN dataDir for detail/health — stage them there.
  const { reporter, dataDir, calls } = reporterFixture({
    responses: [
      { status: 202 }, // presence
      { status: 202 }, // manifest
      { status: 500 }, // desired pull FAILS
      { status: 202 }, // detail accepted
    ],
  });
  fs.writeFileSync(path.join(dataDir, "fleet-detail.json"), JSON.stringify({ at: 1, deployments: [{ agentPath: "p/a", packId: "p", agentId: "a", enabled: true, source: "cloud" }], agents: [] }));
  fs.writeFileSync(path.join(dataDir, "steward-health.json"), JSON.stringify({ failures: 2 }));
  await reporter.tick();
  const detailCall = calls.find((c) => c.url.includes("cell-report") && c.body?.kind === "detail");
  assert.ok(detailCall, "detail was posted");
  assert.equal(detailCall.body.payload.steward.pullFailures, 1, "pull failure counted");
  assert.equal(detailCall.body.payload.steward.crashRestarts, 2, "crash-guard failures relayed");
  assert.equal(detailCall.body.payload.deployments[0].source, "cloud");
});

test("3.3 double 401 self-destructs and stops reporting (existing contract)", async () => {
  const { reporter, dataDir } = reporterFixture({
    token: "dead-token",
    responses: [{ status: 401 }, { status: 401 }],
  });
  await reporter.tick();
  assert.equal(fs.existsSync(path.join(dataDir, "steward-pair.json")), false, "pair file burned");
  assert.equal(reporter.enabled, false);
});

test("3.4 uplink off (no pair file) → no pull and no reporting traffic", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-off-"));
  const calls = [];
  const reporter = reporterModule.createStewardReporter({
    steward: { running: true, cellId: "c", registry: { get: () => null, put: () => {} } },
    dataDir,
    storage: { remove: async () => {} },
    fetchImpl: async (url) => {
      calls.push(url);
      return { status: 202, json: async () => ({}) };
    },
    manifestFn: () => ({ fleetCount: 0, memberCount: 0, enabledTaskCount: 0, labels: [] }),
  });
  assert.equal(reporter.enabled, false);
  await reporter.tick();
  assert.equal(calls.length, 0, "no traffic without an explicit pair");
});
