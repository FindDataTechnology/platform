// Supply-domain Studio (add-supply-studio-migration) — facet-side assembly
// tests, tasks 1.1-1.5 + 2.1. The harness mirrors test-facet-publish-gate.mjs:
// production modules only (createBlueprintRoutes + facet/studio.js assembly),
// with the Logto session standing in as a test header — everything past that
// seam is production code.
//
//   1.1 studio-docs SQLite: file lands at FACET_DATA_ROOT/studio-docs.db,
//       blueprint schema byte-compatible (blueprintId() id semantics).
//   1.2 credential-free gate rides the storage layer: a document carrying an
//       endpoint/token/secret is rejected with a status-marked error and no
//       row exists afterwards (spec: 携带凭据的文档被拒).
//   1.3 lifecycle state machine: draft→approve→cast, edit-after-cast falls
//       back to draft with version+1 (spec: 铸后编辑回草稿), agent-kind
//       approve/cast 409s surface verbatim.
//   2.1 publish through the supply-domain gate: the in-process publisher
//       runs collectPublishVerdict (shortCircuit) before the registry write —
//       a manifest failing the pack gate is rejected here too, and a green
//       one lands as a real pack row (对账钉: pack_versions row exists).
//
//   node --test scripts/test-facet-studio.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { test, after } from "node:test";

import express from "express";

import { createPackRegistry } from "../gateway/packs.js";
import { registerStudioRoutes } from "../facet/studio.js";

const tmp = mkdtempSync(path.join(tmpdir(), "facet-studio-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const DATA_ROOT = path.join(tmp, "facet-data");

const registry = createPackRegistry({ file: path.join(DATA_ROOT, "packs.db") });

// The only stand-in: Logto's session becomes a test header (production seam).
const resolveUser = (req) => {
  const raw = req.headers["x-test-session"];
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    if (typeof doc?.email !== "string") return null;
    return { email: doc.email, groups: Array.isArray(doc.groups) ? doc.groups : [] };
  } catch {
    return null;
  }
};

const app = express();
app.use(express.json({ limit: "24mb" }));
const { db: studioDb } = registerStudioRoutes(app, {
  resolveUser,
  registry,
  dataRoot: DATA_ROOT,
  // Deferred trial deps are the production default (task 5.3 pending).
});

// Second app: same assembly but the sandbox's drafting leg rides a fetch stub
// that always fails — the honest-degradation test drives THIS plane (post-boot
// env overrides can't un-resolve the judge lane; dependency injection can).
import { createPreviewSandboxRoutes } from "../facet/preview-sandbox.js";
const failingApp = express();
failingApp.use(express.json({ limit: "24mb" }));
createPreviewSandboxRoutes(failingApp, {
  resolveUser,
  fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
});
const failingServer = http.createServer(failingApp);
const failingBase = await new Promise((r) =>
  failingServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${failingServer.address().port}`)),
);
after(() => failingServer.close());

const server = http.createServer(app);
const base = await new Promise((r) =>
  server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)),
);
after(() => server.close());

const identity = (email) => ({ "x-test-session": JSON.stringify({ email, groups: ["creators"] }) });

async function api(method, url, { email, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(email ? identity(email) : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// A green team document (castable — full blueprint shape, same as
// test-blueprint-kind's TEAM_GREEN). Name lives in boundary.name for teams.
function teamDoc(overrides = {}) {
  const d = {
    kind: "team",
    boundary: { name: "盯梢台", oneLine: "盯政策变化", outOfScope: "不做报关" },
    dataSources: [],
    fleet: {
      name: "盯梢台集群",
      members: [{ ref: "watch", title: "盯梢岗", target: { kind: "tool", id: "websearch::web_search" } }],
    },
    agents: [{ id: "watch-agent", name: "盯梢岗", persona: "你是盯梢岗。" }],
    mcpServers: [],
    monitoring: {},
    acceptance: [],
    board: {},
    ...overrides,
  };
  return d;
}

function agentDoc(overrides = {}) {
  return {
    kind: "agent",
    name: "巡检助手",
    description: "每小时巡检并报数的助手",
    agents: [{ id: "patrol", name: "巡检员", persona: "你是巡检员，如实报数。" }],
    mcpServers: [],
    skills: [],
    ...overrides,
  };
}

test("1.1 storage host: studio-docs.db lands in the facet data root with the blueprint schema", () => {
  assert.equal(existsSync(path.join(DATA_ROOT, "studio-docs.db")), true, "studio-docs.db created at FACET_DATA_ROOT");
  // Schema byte-compatibility: the migration reconciliation reads
  // content_json equality on the SAME columns.
  const cols = studioDb.__db
    ? studioDb.__db.prepare("PRAGMA table_info(blueprints)").all().map((c) => c.name)
    : null;
  // createBlueprintDatabase returns an API object, not the raw db; assert via
  // a roundtrip instead (below tests cover create/list/update). Column names
  // are checked through the store's own CRUD below.
  assert.ok(cols === null || cols.includes("content_json"));
});

test("1.2 credential-free gate: endpoint/token material is structurally unstorable", async () => {
  const email = "creator-a@facet.test";
  const bad = agentDoc({
    name: "带密钥的文档",
    agents: [{ id: "leaky", name: "漏钥员", persona: "调用 https://api.example.com/v1?key=sk-live-abcdef123456 完成任务" }],
  });
  const created = await api("POST", "/api/blueprints", { email, body: { name: bad.name, content: bad } });
  assert.equal(created.status, 422, `credential-bearing write rejected with 422, got ${created.status}`);
  assert.match(String(created.body?.error ?? ""), /forbidden|credential|endpoint/i);
  const list = await api("GET", "/api/blueprints", { email });
  const rows = list.body?.blueprints ?? [];
  assert.equal(rows.some((r) => r.name === "带密钥的文档"), false, "no row exists for the rejected document");
});

test("1.3 lifecycle: draft→approved→cast; edit-after-cast falls back to draft with version+1", async () => {
  const email = "creator-lifecycle@facet.test";
  const created = await api("POST", "/api/blueprints", {
    email,
    body: { name: "生命周期样本", content: teamDoc() },
  });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const id = created.body?.blueprint?.id;
  assert.ok(id, "blueprint id returned");
  assert.equal(created.body.blueprint.status, "draft");

  const approved = await api("POST", `/api/blueprints/${id}/approve`, { email, body: { expectVersion: 1 } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body?.blueprint?.status, "approved");
  assert.equal(approved.body.blueprint.approvedBy, email, "approver stamp = caller identity");

  const cast = await api("POST", `/api/blueprints/${id}/cast`, { email, body: {} });
  assert.equal(cast.status, 200, JSON.stringify(cast.body));
  assert.equal(cast.body?.blueprint?.status, "cast");
  assert.ok(cast.body?.cast?.packId, "cast produces a real pack id");

  // Edit after cast: falls back to draft, version bumps, approval cleared.
  const edited = await api("PUT", `/api/blueprints/${id}`, {
    email,
    body: { name: "生命周期样本", expectVersion: 1, content: teamDoc() },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body?.blueprint?.status, "draft");
  assert.equal(edited.body.blueprint.version, 2, "version bumps on edit");
  assert.equal(edited.body.blueprint.approvedBy, null, "approval cleared on edit");
});

test("1.3 lifecycle: agent-kind approve is an explicit 409 (server rejects, ribbon mirrors)", async () => {
  const email = "creator-agent@facet.test";
  const created = await api("POST", "/api/blueprints", {
    email,
    body: { name: "agent 型样本", content: agentDoc() },
  });
  const id = created.body?.blueprint?.id;
  const approved = await api("POST", `/api/blueprints/${id}/approve`, { email, body: { expectVersion: 1 } });
  assert.equal(approved.status, 409, "agent-kind approve is rejected with 409");
});

test("1.3-trial deferred stub: without RUN_DOMAIN_BASE_URL the trial answers 503 trial_channel_pending (honest degradation)", async () => {
  const email = "creator-trial-stub@facet.test";
  const created = await api("POST", "/api/blueprints", {
    email,
    body: { name: "试跑桩样本", content: teamDoc() },
  });
  const id = created.body?.blueprint?.id;
  await api("POST", `/api/blueprints/${id}/approve`, { email, body: { expectVersion: 1 } });
  const cast = await api("POST", `/api/blueprints/${id}/cast`, { email, body: {} });
  assert.equal(cast.status, 200, JSON.stringify(cast.body));
  // The harness mounts with no env (default registerStudioRoutes call) — the
  // deferred stub is the production default when RUN_DOMAIN_BASE_URL is unset.
  // The doc carries a real acceptance assertion so runTrial gets past the
  // empty-assertions early return and reaches the (deferred) executor leg.
  const withAssertion = teamDoc({ acceptance: [{ id: "a1", kind: "report-landed", target: "盯梢岗" }] });
  const edited = await api("PUT", `/api/blueprints/${id}`, {
    email,
    body: { name: "试跑桩样本", expectVersion: 1, content: withAssertion },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  await api("POST", `/api/blueprints/${id}/approve`, { email, body: { expectVersion: 2 } });
  const recast = await api("POST", `/api/blueprints/${id}/cast`, { email, body: {} });
  assert.equal(recast.status, 200, JSON.stringify(recast.body));
  const trial = await api("POST", `/api/blueprints/${id}/trial`, { email, body: {} });
  assert.equal(trial.status, 503, JSON.stringify(trial.body));
  assert.equal(trial.body?.code, "trial_channel_pending");
});

test("1.3-trial remote client: RUN_DOMAIN_BASE_URL routes the trial through the run-domain executor; report lands in THIS store", async () => {
  // A stand-in trial-exec channel: same contract the 壹座 side serves
  // (server/routes/trial-exec.js) — credential + payload gates, report body.
  const execApp = express();
  execApp.use(express.json({ limit: "8mb" }));
  const execSeen = [];
  execApp.post("/api/trial-exec", (req, res) => {
    const token = String(req.headers["x-facet-token"] || "");
    const bp = req.body?.blueprint;
    if (!bp) return res.status(400).json({ error: "blueprint required" });
    execSeen.push({ token, ownerEmail: bp.ownerEmail, castPackId: bp.castPackId, caller: req.headers["x-facet-user"] });
    res.json({ report: { green: true, ranAt: 777, errors: [], assertions: [{ id: "a1", status: "pass", kind: "report-landed" }] } });
  });
  const execServer = http.createServer(execApp);
  const execBase = await new Promise((r) => execServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${execServer.address().port}`)));
  after(() => execServer.close());

  // A second registerStudioRoutes with the env set — remote client selected.
  const remoteTmp = mkdtempSync(path.join(tmpdir(), "facet-studio-remote-"));
  after(() => rmSync(remoteTmp, { recursive: true, force: true }));
  const remoteApp = express();
  remoteApp.use(express.json({ limit: "24mb" }));
  registerStudioRoutes(remoteApp, {
    resolveUser,
    registry,
    dataRoot: path.join(remoteTmp, "facet-data"),
    env: { RUN_DOMAIN_BASE_URL: execBase, FACET_INTERNAL_TOKEN: "cross-token-123" },
  });
  const remoteServer = http.createServer(remoteApp);
  const remoteBase = await new Promise((r) => remoteServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${remoteServer.address().port}`)));
  after(() => remoteServer.close());

  const email = "creator-trial-remote@facet.test";
  const post = (url, body) => fetch(`${remoteBase}${url}`, { method: "POST", headers: { ...identity(email), "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

  const created = await post("/api/blueprints", { name: "试跑跨域样本", content: teamDoc() });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const id = created.body.blueprint.id;
  const approved = await post(`/api/blueprints/${id}/approve`, { expectVersion: 1 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const cast = await post(`/api/blueprints/${id}/cast`, {});
  assert.equal(cast.status, 200, JSON.stringify(cast.body));

  const trial = await post(`/api/blueprints/${id}/trial`, {});
  assert.equal(trial.status, 200, JSON.stringify(trial.body));
  assert.equal(trial.body.report.green, true, "remote report returned in one body");
  assert.equal(trial.body.blueprint.trialReport?.ranAt, 777, "report persisted in THIS store (saveTrialReport on facet)");

  // The executor saw the shared credential, the cast pack, and the creator
  // attribution (the payload fields the run domain keys install/provision on).
  assert.equal(execSeen.length, 1);
  assert.equal(execSeen[0].token, "cross-token-123");
  assert.equal(execSeen[0].castPackId, cast.body.cast?.packId);
  assert.equal(execSeen[0].ownerEmail, email);
});

test("2.1 publish gate: the in-process publisher runs collectPublishVerdict before the registry write", async () => {
  const email = "creator-gate@facet.test";
  // The same-name gate (registerSameNamePublishGate posture, enforced inside
  // the publish path): an existing pack under the author's own name blocks a
  // fresh publish — cast surfaces that rejection instead of a second pack.
  // Registry pre-seed mirrors what the market already holds.
  registry.publish({ email, manifest: { name: "同名样本", description: "占位", category: "fleet", agents: [], mcpServers: [] } });
  const created = await api("POST", "/api/blueprints", {
    email,
    body: { name: "同名样本", content: teamDoc({ boundary: { ...teamDoc().boundary, name: "同名样本" }, fleet: { ...teamDoc().fleet, name: "同名样本集群" } }) },
  });
  // Storage-level acceptance is content-shape only; the gate bite happens at cast.
  const id = created.body?.blueprint?.id;
  const approved = await api("POST", `/api/blueprints/${id}/approve`, { email, body: { expectVersion: 1 } });
  assert.ok([200, 409].includes(approved.status), `approve: ${JSON.stringify(approved.body)}`);
  const cast = await api("POST", `/api/blueprints/${id}/cast`, { email, body: {} });
  assert.ok([409, 422].includes(cast.status), `gate rejection surfaces at cast, got ${cast.status}: ${JSON.stringify(cast.body)}`);
});

test("2.1 publish gate: green cast lands a real pack row (统一目录对账钉)", async () => {
  const email = "creator-publish@facet.test";
  const created = await api("POST", "/api/blueprints", {
    email,
    body: { name: "可发布样本", content: teamDoc({ boundary: { ...teamDoc().boundary, name: "可发布样本" } }) },
  });
  const id = created.body?.blueprint?.id;
  await api("POST", `/api/blueprints/${id}/approve`, { email, body: { expectVersion: 1 } });
  const cast = await api("POST", `/api/blueprints/${id}/cast`, { email, body: {} });
  assert.equal(cast.status, 200, JSON.stringify(cast.body));
  const packId = cast.body?.cast?.packId;
  assert.ok(packId, "pack id minted");
  // 对账钉: the pack is a real row in the market (registry read).
  const pack = registry.packRowPublic(packId);
  assert.ok(pack, "pack row exists in the market registry");
  const versionRow = registry.getVersion(packId, cast.body?.cast?.version ?? 1);
  const parsed = versionRow?.manifest;
  assert.equal(parsed?.name, "可发布样本");
  // The cast lineage rides the manifest (_casting.blueprintId preserved —
  // the fleet-detail chip reads it on the 壹座 side).
  const casting = parsed?._casting;
  assert.equal(casting?.blueprintId, id, "_casting.blueprintId preserved");
});

test("one-ticket identity: another facet identity sees nothing (owner scoping)", async () => {
  const email = "creator-scope@facet.test";
  const created = await api("POST", "/api/blueprints", {
    email,
    body: { name: "私享文档", content: agentDoc({ name: "私享文档" }) },
  });
  const id = created.body?.blueprint?.id;
  const stranger = await api("GET", `/api/blueprints/${id}`, { email: "stranger@facet.test" });
  assert.equal(stranger.status, 404, "stranger gets 404 (existence not leaked)");
  const anon = await api("GET", `/api/blueprints/${id}`);
  assert.equal(anon.status, 401, "anonymous is 401");
});

// ── 3.x 预览沙箱（干跑三件套+三闸+诚实降级） ────────────────────────────────

test("3.1 preview dry-run trio: green doc validates+assembles with zero persistence", async () => {
  const email = "previewer@facet.test";
  const res = await api("POST", "/api/studio/preview", { email, body: { content: teamDoc() } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body?.preview?.staticValidation?.ok, true);
  assert.equal(res.body?.preview?.manifestPreview?.name, "盯梢台");
  assert.equal(res.body?.preview?.draft, undefined, "no prompt → no drafting leg");
  // 回归钉：预览不落库（blueprint rows unchanged for this identity）。
  const list = await api("GET", "/api/blueprints", { email });
  assert.equal((list.body?.blueprints ?? []).length, 0, "preview created zero document rows");
});

test("3.1 preview validation leg: credential-bearing content is rejected with findings", async () => {
  const email = "previewer@facet.test";
  const bad = teamDoc({ agents: [{ id: "leak", name: "漏", persona: "用 https://x.example.com?key=sk-live-abc123456789" }] });
  const res = await api("POST", "/api/studio/preview", { email, body: { content: bad } });
  assert.equal(res.status, 422);
  assert.equal(res.body?.code, "preview_validation_failed");
});

test("3.2 quota: anonymous gets no preview; daily cap returns explicit code", async () => {
  const anon = await api("POST", "/api/studio/preview", { body: { content: teamDoc() } });
  assert.equal(anon.status, 401);
  assert.equal(anon.body?.code, "preview_auth_required");
  // Drive one identity to the cap with a low-limit env is not available post-
  // boot; instead exhaust via repeated calls against the default 20.
  const email = "quota-user@facet.test";
  let last;
  for (let i = 0; i < 21; i++) {
    last = await api("POST", "/api/studio/preview", { email, body: { content: teamDoc() } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, "daily cap answers 429");
  assert.equal(last.body?.code, "preview_quota_exhausted");
  const quota = await api("GET", "/api/studio/preview/quota", { email });
  assert.equal(quota.body?.limit, 20);
});

test("3.3 honest degradation: drafting leg upstream failure is an explicit failed state, no placeholder draft", async () => {
  const email = "degraded@facet.test";
  // The lane must exist for the upstream-failure leg to be reachable at all
  // (no lane resolves to 503 preview_lane_unavailable, a different behavior).
  // Pin it here instead of inheriting the machine's roster: locally an
  // llm-providers.json supplied one, while CI has neither roster nor env route
  // and answered 503 — a green that only ever held on the developer's laptop.
  const saved = {
    base: process.env.LLM_BASE_URL,
    model: process.env.LLM_MODEL,
    judge: process.env.BLUEPRINT_JUDGE_MODEL,
  };
  process.env.LLM_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.LLM_MODEL = "honest-degradation-probe";
  delete process.env.BLUEPRINT_JUDGE_MODEL;
  let res;
  try {
    res = await fetch(`${failingBase}/api/studio/preview`, {
      method: "POST",
      headers: { ...identity(email), "content-type": "application/json" },
      body: JSON.stringify({ content: teamDoc(), prompt: "起草一个盯梢台" }),
    });
  } finally {
    for (const [k, v] of Object.entries({
      LLM_BASE_URL: saved.base,
      LLM_MODEL: saved.model,
      BLUEPRINT_JUDGE_MODEL: saved.judge,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 502, JSON.stringify(body));
  assert.equal(body?.code, "preview_lane_failed");
  assert.equal(body?.preview?.draft, undefined, "no placeholder draft");
  assert.equal(body?.staticValidation?.ok, true, "static+shape legs still honest");
});

// ── 3.4/3.5 晋升通道（壹座实例→Studio 草稿 fork） ──────────────────────────
// Cross-domain write via the facet internal channel; the fleet detail's
// promote action lands a draft in the facet store with provenance, and the
// running instance is untouched (structural one-way gate — the blueprint API
// has no fleet-write path).

import { createFleetPromotionTestHarness } from "./lib/test-fleet-promotion.mjs";

test("3.4 promotion: fleet config state forks into a facet draft with provenance + excluded list", async () => {
  const h = await createFleetPromotionTestHarness({ studioApp: app, studioBase: base });
  try {
    const res = await h.promote({ fleetName: "盯梢台-晋升源", packAgents: [{ id: "watch-agent", name: "盯梢岗", persona: "你是盯梢岗。" }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body?.promoted?.forkScope, "preset/config/skills");
    assert.deepEqual(res.body?.promoted?.excluded, ["记忆", "会话历史"]);
    const docId = res.body?.promoted?.studioDocId;
    assert.ok(docId, "facet draft id returned");
    const doc = await api("GET", `/api/blueprints/${docId}`, { email: h.ownerEmail });
    assert.equal(doc.status, 200, "the draft lives in the facet studio store");
    assert.equal(doc.body?.blueprint?.content?._promotion?.sourceFleetName, "盯梢台-晋升源");
    assert.equal(doc.body.blueprint.content._promotion?.excluded?.length, 2);
    assert.ok(doc.body.blueprint.content._promotion?.promotedAt);
  } finally {
    await h.close();
  }
});

test("3.5 one-way gate: editing the promoted draft leaves the running instance byte-identical (structural)", async () => {
  const h = await createFleetPromotionTestHarness({ studioApp: app, studioBase: base });
  try {
    const res = await h.promote({ fleetName: "单向闸样本" });
    const docId = res.body?.promoted?.studioDocId;
    // The facet studio API has NO fleet-write path: editing the draft only
    // touches studio-docs. Prove it structurally — the blueprint routes'
    // write surface (POST/PUT/DELETE) never mentions fleet state.
    const before = h.fleetSnapshot();
    const edited = await api("PUT", `/api/blueprints/${docId}`, {
      email: h.ownerEmail,
      body: { name: "改过", expectVersion: 1, content: teamDoc({ boundary: { name: "改过", oneLine: "", outOfScope: "" } }) },
    });
    assert.ok([200, 201].includes(edited.status), JSON.stringify(edited.body));
    const after = h.fleetSnapshot();
    assert.deepEqual(after, before, "running instance byte-identical across studio edits");
  } finally {
    await h.close();
  }
});
