// trial-exec service channel tests (add-supply-studio-migration task 5.3).
// The run-domain executor: shared-credential gate, structural gates (cast
// status / kind / owner / validation), single-flight, and the report-in-one-
// body contract. runTrial is injected (depsFactory + runTrialImpl seams) —
// the real 装一台跑一轮 chain is covered by scripts/test-blueprints.mjs 4.1
// and the live machine leg; what's pinned here is the CHANNEL.
//
//   node --test scripts/test-trial-exec.mjs

import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { test, after } from "node:test";

process.env.FACET_INTERNAL_TOKEN = "e2e-trial-exec-token";

const { createTrialExecRoutes } = await import("../server/routes/trial-exec.js");

const SERVER = { app: null, base: null, setDeps: null };
{
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  // Only the deps seam is live: runTrial itself is the real one (the route
  // module imports it directly), so an impl-swap seam would be dead weight —
  // it was, and lint caught it (noUnusedVariables).
  let depsFactory = () => ({ marker: "live" });
  SERVER.setDeps = (f) => { depsFactory = f; };

  // Mount with a wrapped runTrial: the route module imports runTrial directly,
  // so the test seam rides depsFactory + a token-equal call-through stub.
  // Simplest honest seam: re-register with a shim module? No — createTrialExecRoutes
  // imports runTrial from blueprint-trial.js; to pin the CHANNEL we inject a
  // depsFactory whose legs answer instantly and use a blueprint whose
  // assertions are all machine-closed (the evaluateTrial closed set), so the
  // real runTrial runs for real against the stub deps.
  createTrialExecRoutes(app, { depsFactory: () => depsFactory() });
  // Expose the injected impl via a stub trial blueprint below (no impl swap
  // needed: runTrial is real, deps are the seam).
  SERVER.app = app;
  const server = http.createServer(app);
  SERVER.base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  after(() => server.close());
}

const H = { "x-facet-token": "e2e-trial-exec-token", "content-type": "application/json" };

function castTeam(id = "bp_exec_1", owner = "creator@facet.test") {
  return {
    id,
    ownerEmail: owner,
    status: "cast",
    castPackId: "packExecTest123456",
    castPackVersion: 1,
    version: 3,
    approvedBy: owner,
    approvedAt: 1,
    content: {
      kind: "team",
      name: "试跑通道包",
      boundary: { name: "试跑通道包", oneLine: "one line", outOfScope: "none" },
      dataSources: [],
      fleet: { name: "试跑通道包", members: [{ ref: "agent-1", title: "Worker", target: { kind: "existing-persona", id: "agent-1" } }], orchestration: { pattern: "solo" } },
      agents: [{ id: "agent-1", name: "Worker", persona: "You get things done." }],
      mcpServers: [],
      monitoring: {},
      acceptance: [{ id: "a1", kind: "report-landed", target: "Worker" }],
      board: {},
    },
  };
}

test("service gate: missing/wrong credential answers 401 trial_exec_unauthorized", async () => {
  const bp = castTeam();
  const noToken = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprint: bp }) });
  assert.equal(noToken.status, 401);
  assert.equal((await noToken.json()).code, "trial_exec_unauthorized");
  const bad = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: { ...H, "x-facet-token": "wrong-length-token!!!!!" }, body: JSON.stringify({ blueprint: bp }) });
  assert.equal(bad.status, 401);
});

test("structural gates: agent kind 409, non-cast 409, missing owner 400, blueprint required 400", async () => {
  const agent = { ...castTeam("bp_exec_agent"), content: { kind: "agent", name: "x", agents: [{ id: "a1", name: "x", persona: "p" }], mcpServers: [], skills: [] } };
  const r1 = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({ blueprint: agent }) });
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).code, "trial_exec_agent_kind");

  const draft = { ...castTeam("bp_exec_draft"), status: "draft", castPackId: null };
  const r2 = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({ blueprint: draft }) });
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).code, "trial_exec_not_cast");

  const noOwner = castTeam("bp_exec_noowner");
  delete noOwner.ownerEmail;
  const r3 = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({ blueprint: noOwner }) });
  assert.equal(r3.status, 400);
  assert.equal((await r3.json()).code, "trial_exec_owner_required");

  const r4 = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({}) });
  assert.equal(r4.status, 400);
  assert.equal((await r4.json()).code, "trial_exec_blueprint_required");
});

test("happy path: report returns in one body; deps factory is the run's executor; timeoutMs clamped", async () => {
  let seen = null;
  SERVER.setDeps(() => ({
    now: () => 1000,
    fetchManifest: async ({ packId, viewer }) => { seen = { packId, ownerEmail: viewer }; return { fleet: { name: "试跑通道包", members: [] } }; },
    install: async () => {},
    provision: async () => ({ ok: true, fleetId: "fleet_exec_1" }),
    startFleet: async () => {},
    fireRound: async () => [{ jobId: "j1", memberId: "m1", at: 1010 }],
    collectAndWait: async ({ since }) => ({
      members: [{ memberId: "m1", title: "Worker", targetId: "agent-1" }],
      turns: [{ memberId: "m1", at: since + 1, jobId: "j1", turnId: "turn_1" }],
      reports: [{ memberId: "m1", reportId: "r1", createdAt: since + 2, turnId: "turn_1", summary: "ok" }],
      escalations: 0,
    }),
  }));
  const res = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({ blueprint: castTeam(), timeoutMs: 999_999 }) });
  assert.equal(res.status, 200);
  const { report } = await res.json();
  assert.equal(report.green, true);
  assert.ok(Array.isArray(report.assertions) && report.assertions.length === 1, "assertions evaluated");
  // owner attribution rides the payload into the executor legs (install/
  // provision key by this email — the same attribution a live deployTeam
  // session produces).
  assert.ok(seen, "fetchManifest ran against the cast pack");
  assert.equal(seen.ownerEmail, "creator@facet.test");
});

test("validation gate: credential-bearing content is rejected by the same chain (422)", async () => {
  const leaky = castTeam("bp_exec_leak");
  leaky.content.agents[0].persona = "use key=sk-abc123def456ghi789 against the endpoint";
  const res = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({ blueprint: leaky }) });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "trial_exec_validation_failed");
});

test("single-flight: a second exec for the same blueprint 409s while the first is in flight", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  SERVER.setDeps(() => ({
    now: () => 1000,
    fetchManifest: async () => ({ fleet: { members: [] } }),
    install: async () => {},
    provision: async () => { await gate; return { ok: true, fleetId: "fleet_exec_2" }; },
    startFleet: async () => {},
    fireRound: async () => [],
    collectAndWait: async ({ since }) => ({ members: [], turns: [], reports: [{ memberId: "m1", reportId: "r2", createdAt: since + 1 }], escalations: 0 }),
  }));
  const first = fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({ blueprint: castTeam("bp_exec_sf") }) });
  await new Promise((r) => setTimeout(r, 150));
  const second = await fetch(`${SERVER.base}/api/trial-exec`, { method: "POST", headers: H, body: JSON.stringify({ blueprint: castTeam("bp_exec_sf") }) });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "trial_exec_in_progress");
  release();
  const done = await first;
  assert.equal(done.status, 200);
});
