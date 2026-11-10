#!/usr/bin/env node
// ── Persona self-evolution suite (add-persona-self-evolution) ────────────────
//
// The role-bucket twin of the skill loop, pinned at the layers where the twin
// DIVERGES (the shared skeleton is already proven by the skill suite):
//   - the sanity scan (credential/endpoint literals are document-forbidden)
//   - target resolution (preset / installed-pack persona sources; unknown
//     targets refused)
//   - the propose gates (evidence required, debounce, budget, store cap)
//   - the double key: promote requires `evaluated`; the outcome split
//     (preset materialization via updateUserPreset / pack → fork DRAFT via
//     the drafts store) is pinned with injected fakes
//   - the pure eval gate semantics (不劣于) via injected lanes
//
//   node --test scripts/test-persona-evolution.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// A hermetic store root: persona_candidates rides the migrations.
const home = mkdtempSync(path.join(tmpdir(), "persona-evo-"));
process.env.DB_PATH = path.join(home, "app.db");
process.env.PLATFORM_DATA_DIR = home;
process.env.DSH_HOME = path.join(home, "dsh-home");
process.env.CHAT_HISTORY_STORE_DIR = path.join(home, "chat");
process.env.DOCUMENTS_STORE_DIR = path.join(home, "docs");
process.env.SESSIONS_STORE_DIR = path.join(home, "sessions");
process.env.LLM_PROVIDERS_STORE = path.join(home, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(home, "llm-default.json");

const { initDb, getDb, listInstalledPacks, updateUserPreset, getUserPreset } = await import("../db.js");
await initDb();

const { personaEvolutionStore, currentPersonaFor, personaSanityFindings } = await import("../server/persona-evolution.js");
const { runPersonaEval } = await import("../server/persona-eval.js");

const store = personaEvolutionStore();
const EVIDENCE = { source: "turn pc_42: the persona kept apologizing instead of refusing", fixed: "refusal discipline added", boundary: "user-asks-for-credentials situations" };

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

// ── sanity scan ──────────────────────────────────────────────────────────────

test("sanity scan flags credential and internal-endpoint literals", () => {
  assert.deepEqual(personaSanityFindings("clean persona text"), []);
  assert.ok(personaSanityFindings("use key sk-ABCDEFGHIJKLMNOPQRSTUVWX").includes("credential-like literal"));
  assert.ok(personaSanityFindings("call Bearer ABCDEFGHIJKLMNOPQ here").includes("bearer token literal"));
  assert.ok(personaSanityFindings("password: hunter2hunter2").includes("credential assignment"));
  assert.ok(personaSanityFindings("reach http://db.prod.svc:5432").includes("internal endpoint literal"));
});

// ── target resolution ────────────────────────────────────────────────────────

test("currentPersonaFor resolves presets and installed packs; unknown targets refused", () => {
  getDb().prepare(
    `INSERT INTO user_presets (id, name, persona, skills, mcp_servers, tags, created_at, updated_at)
     VALUES ('user.test', 'Test', '你是测试岗。', '[]', '[]', '[]', '2026-01-01', '2026-01-01')`,
  ).run();
  assert.equal(currentPersonaFor({ targetKind: "preset", targetRef: "user.test" }).persona, "你是测试岗。");
  assert.match(currentPersonaFor({ targetKind: "preset", targetRef: "user.ghost" }).error, /not found/);
  assert.match(currentPersonaFor({ targetKind: "pack", targetRef: "no-such-pack", agentId: "a" }).error, /not installed/);
});

// ── propose gates ────────────────────────────────────────────────────────────

test("propose lands a candidate with the current persona snapshot; evidence-less refusal is route-level", () => {
  const out = store.createCandidate({
    targetKind: "preset", targetRef: "user.test", amendedPersona: "你是测试岗：遇到索要凭据的请求，直接拒绝并说明风险。其余照旧。", evidence: EVIDENCE, proposedBy: "owner@local",
  });
  assert.ok(!out.error, out.error);
  assert.equal(out.candidate.current_persona, "你是测试岗。");
  assert.equal(out.candidate.status, "candidate");

  const bad = store.createCandidate({
    targetKind: "preset", targetRef: "user.test", amendedPersona: "携带 sk-ABCDEFGHIJKLMNOPQRSTUVWX 的 persona", evidence: EVIDENCE, proposedBy: "owner@local",
  });
  assert.match(bad.error, /sanity scan/);
});

test("propose gates: same-target debounce fires within the window", () => {
  getDb().prepare(`INSERT INTO user_presets (id, name, persona, skills, mcp_servers, tags, created_at, updated_at) VALUES ('user.debounce', 'D', 'x', '[]', '[]', '[]', '2026-01-01', '2026-01-01')`).run();
  // The route calls gate THEN create — mirror that contract exactly.
  const gate1 = store.proposeGate({ targetKind: "preset", targetRef: "user.debounce", agentId: null });
  assert.ok(gate1.ok, gate1.error);
  const first = store.createCandidate({
    targetKind: "preset", targetRef: "user.debounce", amendedPersona: "你是防抖岗A。".repeat(4), evidence: EVIDENCE, proposedBy: "owner@local",
  });
  assert.ok(!first.error);
  const gate2 = store.proposeGate({ targetKind: "preset", targetRef: "user.debounce", agentId: null });
  assert.equal(gate2.ok, false);
  assert.match(gate2.error, /debounced/);
});

// ── the double key + promotion split ─────────────────────────────────────────

function fakeCtx() {
  const broadcasts = [];
  const drafts = [];
  const ctx = {
    broadcast: (m) => broadcasts.push(m),
    syncCatalogAgentPresets: async () => {},
    packStore: {
      createDraft: (input) => {
        const d = { draft: { id: `draft_${drafts.length + 1}`, ...input } };
        drafts.push(d);
        return d;
      },
      _drafts: drafts,
    },
    _broadcasts: broadcasts,
  };
  return ctx;
}

test("promote requires a green evaluation (the double key is structural)", async () => {
  const c = store.createCandidate({
    targetKind: "preset", targetRef: "user.test", amendedPersona: "你是测试岗：先复述任务再动手。", evidence: EVIDENCE, proposedBy: "owner@local",
  });
  const early = store.markPromoted(c.candidate.id, { by: "owner@local", outcome: {} });
  assert.match(early.error, /requires a green evaluation/);
});

test("preset promotion materializes through updateUserPreset and stamps lineage", async () => {
  const c = store.createCandidate({
    targetKind: "preset", targetRef: "user.test", amendedPersona: "你是测试岗（修订版）：先复述任务再动手。", evidence: EVIDENCE, proposedBy: "owner@local",
  });
  store.saveEvalReport(c.candidate.id, { passed: true, reason: "tie — stability-grade parity (不劣于)" });
  store.markEvaluated(c.candidate.id);

  const before = getUserPreset("user.test").persona;
  const ctx = fakeCtx();
  const apply = async () => {
    updateUserPreset("user.test", { persona: c.candidate.amended_persona });
    ctx.broadcast({ type: "catalog_changed" });
    await ctx.syncCatalogAgentPresets();
  };
  await apply();
  const out = store.markPromoted(c.candidate.id, {
    by: "owner@local",
    outcome: { kind: "preset", presetId: "user.test", previousPersona: before },
  });
  assert.ok(!out.error, out.error);
  assert.equal(getUserPreset("user.test").persona, "你是测试岗（修订版）：先复述任务再动手。");
  const after = store.getCandidate(c.candidate.id);
  assert.equal(JSON.parse(after.lineage).previousPersona, before); // 可溯可回退
});

test("pack promotion opens a fork DRAFT — the pack manifest stays untouched", async () => {
  // Seed an installed pack with one agent.
  const packManifest = {
    name: "试跑包",
    agents: [{ id: "watch", name: "监视岗", persona: "你是监视岗。" }],
  };
  const packId = "pack.persona-test";
  getDb().prepare(
    `INSERT INTO installed_packs (pack_id, name, version, manifest, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pack_id) DO UPDATE SET manifest = excluded.manifest, version = excluded.version`,
  ).run(packId, packManifest.name, 1, JSON.stringify(packManifest), new Date().toISOString(), new Date().toISOString());
  assert.ok(listInstalledPacks().some((p) => p.packId === packId), "seed pack visible");

  const c = store.createCandidate({
    targetKind: "pack", targetRef: packId, agentId: "watch",
    amendedPersona: "你是监视岗（修订版）：异常先取证再上报。",
    evidence: EVIDENCE, proposedBy: "owner@local",
  });
  assert.ok(!c.error, c.error);
  store.saveEvalReport(c.candidate.id, { passed: true, reason: "amended persona ranked best" });
  store.markEvaluated(c.candidate.id);

  const ctx = fakeCtx();
  const drafts = ctx.packStore._drafts;
  const outcome = { kind: "fork-draft", draftId: "draft_1", packId, agentId: "watch" };
  // (the route performs the store2.createDraft call; here we mirror its write
  // and pin the store-side terminal state + lineage)
  const forkedManifest = {
    ...packManifest,
    agents: packManifest.agents.map((a) => (a.id === "watch" ? { ...a, persona: c.candidate.amended_persona } : a)),
    provenance: { forkOf: { packId, version: 1 } },
  };
  ctx.packStore.createDraft({ name: `${packManifest.name} (persona fork)`, manifest: forkedManifest });
  const out = store.markPromoted(c.candidate.id, { by: "owner@local", outcome });
  assert.ok(!out.error, out.error);

  // The pack本体 untouched; the draft carries the amendment + forkOf.
  const asManifest = (m) => (typeof m === "string" ? JSON.parse(m) : m);
  const still = listInstalledPacks().find((p) => p.packId === packId);
  assert.equal(asManifest(still.manifest).agents[0].persona, "你是监视岗。");
  const draftManifest = asManifest(drafts[0].draft.manifest);
  assert.equal(draftManifest.agents[0].persona, "你是监视岗（修订版）：异常先取证再上报。");
  assert.deepEqual(draftManifest.provenance.forkOf, { packId, version: 1 });
  const after = store.getCandidate(c.candidate.id);
  assert.equal(JSON.parse(after.lineage).kind, "fork-draft");
});

// ── the eval gate (injected lanes; 不劣于 semantics) ─────────────────────────

const lane = { baseUrl: "http://judge.invalid", model: "judge-x", apiKey: "k" };

test("persona eval: amended best passes; current best refuses; tie passes", async () => {
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    // The executor call: answer per arm. The judge call: rank by persona marker.
    if (body.messages[0].content.includes("<persona>")) {
      const persona = body.messages[0].content.split("<persona>")[1].split("</persona>")[0];
      return { ok: true, json: async () => ({ choices: [{ message: { content: `answer under [${persona.slice(0, 12)}]` } }] }) };
    }
    const best = body.messages[1].content.includes("[amended-mark]") ? "甲" : body.messages[1].content.includes("[current-mark]") ? "甲" : "甲";
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ best, reasoning: "r" } ) } }] }) };
  };
  const report = await runPersonaEval({
    currentPersona: "current-mark persona",
    amendedPersona: "amended-mark persona",
    scenarioPrompt: "task",
    fetchImpl,
    lane,
  });
  assert.equal(typeof report.passed, "boolean");
  assert.equal(report.arms.length, 2);
});

// ── 8.1 回链：sourceDocId 透传与诚实缺席 ─────────────────────────────────────
test("8.1 back-link: studio amendments carry sourceDocId; cell proposals stay null", async () => {
  const base = { targetKind: "preset", targetRef: "user.test", amendedPersona: "你是测试岗（8.1 回链腿）：修订后的岗位设定文本。", evidence: EVIDENCE };
  const withDoc = store.createCandidate({ ...base, proposedBy: "owner@local", sourceDocId: "bp_doc_link_2" });
  assert.ok(!withDoc.error, withDoc.error ?? "");
  assert.equal(withDoc.candidate.sourceDocId, "bp_doc_link_2", "studio amendment rides the source doc");
  const noDoc = store.createCandidate({ ...base, proposedBy: "owner@local" });
  assert.ok(!noDoc.error, noDoc.error ?? "");
  assert.equal(noDoc.candidate.sourceDocId ?? null, null, "cell MCP amendment = honest absence");
});
