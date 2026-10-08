// Unit tests for the model-discovery core (add-llm-model-discovery, tasks
// 1.1–1.4 / 4.1):
//   - family metadata table + ordering rank (probe-verified 2026-09-30 values)
//   - classifyModels against a real local mock gateway — one id per bucket
//     (serving / unauthorized / upstream_down / rate_limited / not_chat) plus
//     the single network retry
//   - syncProvider: serving ids append with family metadata, dead roster ids
//     survive flagged (no evict), roster re-orders by family rank, discovery
//     map persists, response shape { statuses, added, rosterSize }
//   - guards: unknown id → not_found, keyless provider → invalid, reserved
//     "volces" sync persists into the route override (dry run retired)
//   - lock behavior: a second concurrent sync → busy; a sync whose merge
//     collides with a held write lock → BusyError
//   - updateProvider models array: replace + family fallbacks, invalid
//     payloads rejected with the roster untouched
//
// Stores are redirected to a temp dir via LLM_PROVIDERS_STORE so real user
// data is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-discovery-"));
process.env.LLM_PROVIDERS_STORE = path.join(tmpRoot, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(tmpRoot, "llm-default.json");
delete process.env.LLM_API_KEY;

const llm = await import("../llm-providers.js");

// ── Mock gateway ─────────────────────────────────────────────────────────────

// POST /v1/chat/completions behavior keyed by model id: "ok" | "unauthorized"
// | "upstream_down" | "rate_limited" | "not_chat" | { flaky: true } (network
// error on the first attempt, ok afterwards). GET /v1/models lists every key.
const behavior = {};
const attempts = {};

// The mock's id list (GET /v1/models) is the behavior map's keys, so each
// test must pin exactly the ids it asserts on — leftovers from earlier tests
// would otherwise show up as extra roster entries.
function setBehavior(map) {
  for (const k of Object.keys(behavior)) delete behavior[k];
  Object.assign(behavior, map);
}

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: Object.keys(behavior).map((id) => ({ id })) }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const model = JSON.parse(Buffer.concat(chunks).toString()).model;
      attempts[model] = (attempts[model] || 0) + 1;
      const n = attempts[model];
      const b = behavior[model];
      const send = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (b === "ok") return send(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      if (b === "not_chat") return send(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] });
      if (b === "unauthorized") {
        return send(404, { error: { message: `Model ${model} is not supported by any configured account in this group` } });
      }
      if (b === "upstream_down") {
        return send(503, { error: { message: "Upstream service temporarily unavailable, please retry later" } });
      }
      if (b === "rate_limited") return send(429, { error: { message: "Rate limit exceeded for this token" } });
      if (b?.flaky && n === 1) return res.destroy(); // network error on the first probe
      if (b?.flaky) return send(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      return send(500, { error: { message: `unexpected model ${model}` } });
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const MOCK_BASE = `http://127.0.0.1:${mockServer.address().port}/v1`;
test.after(() => mockServer.close());

// ── 1.1 Family metadata table ────────────────────────────────────────────────

test("family table: deepseek ids get 32768 + efforts, both id shapes", () => {
  for (const id of ["deepseek/deepseek-v4.1-flash", "deepseek-v4.1-flash", "deepseek-v4-pro"]) {
    const meta = llm.modelFamilyMeta(id);
    assert.equal(meta.maxTokens, 32768, id);
    assert.equal(meta.contextWindow, 128000, id);
    assert.deepEqual(meta.reasoningEfforts, ["low", "medium", "high"], id);
    assert.equal(llm.modelFamilyRank(id), 0, id);
  }
});

test("family table: unknown families get conservative defaults", () => {
  const meta = llm.modelFamilyMeta("mimo-v2.6-flash");
  assert.equal(meta.contextWindow, 128000);
  assert.equal(meta.maxTokens, 8192);
  assert.deepEqual(meta.reasoningEfforts, []);
  assert.equal(llm.modelFamilyRank("mimo-v2.6-flash"), 2);
});

test("family table: glm-5.3-flash gets 32768, sibling glm ids default", () => {
  assert.equal(llm.modelFamilyMeta("glm-5.3-flash").maxTokens, 32768);
  assert.equal(llm.modelFamilyMeta("glm-5.2").maxTokens, 8192);
  assert.equal(llm.modelFamilyRank("glm-anything"), 1);
});

test("family rank: free pool always last, rest rank 3", () => {
  assert.equal(llm.modelFamilyRank("deepseek-v4-pro"), 0);
  assert.equal(llm.modelFamilyRank("glm-5.3-flash"), 1);
  assert.equal(llm.modelFamilyRank("cohere/north-mini-code:free"), 4);
  assert.equal(llm.modelFamilyRank("kimi-k2.6"), 3);
});

// ── 1.2 classifyModels against the mock gateway ──────────────────────────────

test("classifyModels lands every fixture id in its bucket", async () => {
  setBehavior({
    "ok-model": "ok",
    "acct-model": "unauthorized",
    "down-model": "upstream_down",
    "limit-model": "rate_limited",
    "empty-model": "not_chat",
  });
  const ids = Object.keys(behavior);
  const result = await llm.classifyModels(MOCK_BASE, "sk-test-key", ids);
  assert.equal(result["ok-model"].status, "serving");
  assert.equal(result["acct-model"].status, "unauthorized");
  assert.equal(result["down-model"].status, "upstream_down");
  assert.equal(result["limit-model"].status, "rate_limited");
  assert.equal(result["empty-model"].status, "not_chat");
  // Every listed id is covered exactly once.
  assert.deepEqual(Object.keys(result).sort(), ids.sort());
});

test("classifyModels retries a network failure once and upgrades to serving", async () => {
  behavior["flaky-model"] = { flaky: true };
  const result = await llm.classifyModels(MOCK_BASE, "sk-test-key", ["flaky-model"]);
  assert.equal(result["flaky-model"].status, "serving");
  assert.equal(attempts["flaky-model"], 2);
});

test("classifyModels never exposes raw error bodies with key material", async () => {
  behavior["boom-model"] = "unauthorized";
  const result = await llm.classifyModels(MOCK_BASE, "sk-test-key", ["boom-model"]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("sk-test-key"), "key must not appear in classifications");
});

// ── 1.3 syncProvider merge ───────────────────────────────────────────────────

function resetStore(providers) {
  fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify({ providers }));
}

test("syncProvider appends serving ids, flags (never evicts) dead roster ids", async () => {
  const created = llm.createProvider({ name: "Merge Fixture", baseUrl: MOCK_BASE, apiKey: "sk-merge-key" });
  // Hand-tuned entry that the probe will find dead: its fields must survive.
  resetStore([
    {
      id: created.id,
      name: "Merge Fixture",
      baseUrl: MOCK_BASE,
      apiKey: "sk-merge-key",
      type: "openai-completions",
      models: [
        { id: "dead-model", name: "Hand Tuned", contextWindow: 111000, maxTokens: 4096 },
        { id: "serving-roster-model", name: "Already Here", contextWindow: 128000, maxTokens: 8192 },
      ],
      reasoningEfforts: [],
      createdAt: new Date().toISOString(),
      lastTest: null,
    },
  ]);
  setBehavior({
    "dead-model": "upstream_down",
    "serving-roster-model": "ok",
    "brand-new-model": "ok",
    "unauth-model": "unauthorized",
  });

  const result = await llm.syncProvider(created.id);
  assert.deepEqual(Object.keys(result).sort(), ["added", "rosterSize", "statuses"]);
  assert.deepEqual(result.added, ["brand-new-model"]);
  assert.equal(result.rosterSize, 3);

  const record = llm.listUserProviders().find((p) => p.id === created.id);
  // Dead roster id survives; new serving id appended; unauthorized id NOT merged.
  assert.deepEqual(record.models.sort(), ["brand-new-model", "dead-model", "serving-roster-model"]);
  // Status map covers every listed id, dead one flagged.
  assert.equal(record.discovery["dead-model"].status, "upstream_down");
  assert.equal(record.discovery["serving-roster-model"].status, "serving");
  assert.equal(record.discovery["brand-new-model"].status, "serving");
  assert.equal(record.discovery["unauth-model"].status, "unauthorized");
  assert.ok(record.discovery["dead-model"].probedAt, "probedAt recorded");

  // The persisted roster keeps the hand-tuned fields and adds family metadata.
  const raw = JSON.parse(fs.readFileSync(process.env.LLM_PROVIDERS_STORE, "utf8"));
  const models = raw.providers[0].models;
  const dead = models.find((m) => m.id === "dead-model");
  assert.deepEqual(dead, { id: "dead-model", name: "Hand Tuned", contextWindow: 111000, maxTokens: 4096 });
  const fresh = models.find((m) => m.id === "brand-new-model");
  assert.equal(fresh.contextWindow, 128000);
  assert.equal(fresh.maxTokens, 8192);
  assert.ok(!("apiKey" in JSON.parse(JSON.stringify(record))), "client record has no key");
});

test("syncProvider orders the roster: family rank then id, free pool last", async () => {
  const created = llm.createProvider({ name: "Order Fixture", baseUrl: MOCK_BASE, apiKey: "sk-order-key" });
  setBehavior({
    "zeta-model": "ok",
    "mimo-v2.6-flash": "ok",
    "glm-5.3-flash": "ok",
    "deepseek-v4.1-flash": "ok",
    "deepseek-v4-pro": "ok",
    "aaa/whatever:free": "ok",
  });
  await llm.syncProvider(created.id);
  const record = llm.listUserProviders().find((p) => p.id === created.id);
  assert.deepEqual(record.models, [
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "glm-5.3-flash",
    "mimo-v2.6-flash",
    "zeta-model",
    "aaa/whatever:free",
  ]);
});

test("syncProvider deepseek merge carries family efforts into the dsh entries", async () => {
  const created = llm.createProvider({ name: "Efforts Fixture", baseUrl: MOCK_BASE, apiKey: "sk-eff-key" });
  // Not an id in DEFAULT_MODELS, so the sync is what merges it.
  setBehavior({ "deepseek-v4.1-flash": "ok" });
  await llm.syncProvider(created.id);
  const entries = llm.buildUserProviderEntries();
  const routeModel = entries.providers[created.id].models.find((m) => m.id === "deepseek-v4.1-flash");
  assert.deepEqual(routeModel.reasoningEfforts, { low: "low", medium: "medium", high: "high" });
  const flat = entries.models.find((m) => m.id === "deepseek-v4.1-flash");
  assert.deepEqual(flat.reasoningEfforts, ["low", "medium", "high"]);
});

// ── 1.4 Guards ───────────────────────────────────────────────────────────────

test("syncProvider throws not_found for unknown ids", async () => {
  await assert.rejects(() => llm.syncProvider("nope"), (e) => e.code === "not_found");
});

test("syncProvider throws invalid for a provider without a key", async () => {
  resetStore([
    { id: "keyless", name: "Keyless", baseUrl: MOCK_BASE, apiKey: "", models: [], reasoningEfforts: [], lastTest: null },
  ]);
  await assert.rejects(() => llm.syncProvider("keyless"), (e) => e.code === "invalid");
});

test("reserved volces sync persists into the override (add-editable-llm-route)", async () => {
  const prevKey = process.env.LLM_API_KEY;
  const prevBase = process.env.LLM_BASE_URL;
  process.env.LLM_API_KEY = "sk-volces-sync";
  process.env.LLM_BASE_URL = MOCK_BASE;
  try {
    setBehavior({ "deepseek-v4.1-flash": "ok", "never-seen-model": "ok", "dead-volces": "upstream_down" });
    const result = await llm.syncProvider("volces");
    assert.equal(result.dryRun, undefined, "the dry-run marker is gone");
    assert.deepEqual(result.added, ["never-seen-model"]);
    assert.equal(result.statuses["dead-volces"].status, "upstream_down");
    // The override roster seeds from the baked VOLCES_MODELS (13) + the merge.
    assert.equal(result.rosterSize, 14);
    const override = llm.getVolcesOverride();
    assert.ok(override.models.some((m) => m.id === "never-seen-model"), "serving id persisted");
    assert.equal(override.discovery["dead-volces"].status, "upstream_down");
  } finally {
    llm.clearVolcesOverride();
    process.env.LLM_API_KEY = prevKey;
    process.env.LLM_BASE_URL = prevBase;
    delete behavior["dead-volces"];
  }
});

// ── Lock behavior ────────────────────────────────────────────────────────────

test("a second concurrent sync is rejected busy while one is running", async () => {
  const created = llm.createProvider({ name: "Lock Fixture", baseUrl: MOCK_BASE, apiKey: "sk-lock-key" });
  // Slow model-list response holds the classification phase open.
  const slow = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "slow-model" }] }));
    }, 300);
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  const slowBase = `http://127.0.0.1:${slow.address().port}/v1`;
  const rec = JSON.parse(fs.readFileSync(process.env.LLM_PROVIDERS_STORE, "utf8"));
  rec.providers.find((p) => p.id === created.id).baseUrl = slowBase;
  fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify(rec));

  try {
    const first = llm.syncProvider(created.id);
    await new Promise((r) => setTimeout(r, 50)); // let the first take the flag
    await assert.rejects(() => llm.syncProvider(created.id), (e) => e.code === "busy");
    const result = await first;
    assert.equal(result.statuses["slow-model"].status, "serving");
  } finally {
    slow.close();
  }
});

test("a sync whose merge collides with a held write lock rejects busy", async () => {
  const created = llm.createProvider({ name: "Merge Lock Fixture", baseUrl: MOCK_BASE, apiKey: "sk-mlock-key" });
  setBehavior({ "plain-model": "ok" });
  // Hold the write lock across the classification window.
  const release = llm.tryWithWriteLock(() => new Promise((r) => setTimeout(r, 400)));
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(() => llm.syncProvider(created.id), (e) => e.code === "busy");
  await release;
});

// ── updateProvider models array (runtime roster editing) ─────────────────────

test("updateProvider replaces the roster with family-table fallbacks", () => {
  const created = llm.createProvider({ name: "Edit Fixture", baseUrl: MOCK_BASE, apiKey: "sk-edit-key" });
  const updated = llm.updateProvider(created.id, {
    models: [
      { id: "deepseek-v4.1-flash" },
      { id: "custom-model", name: "Custom", contextWindow: 64000, maxTokens: 2048 },
    ],
  });
  assert.deepEqual(updated.models, ["deepseek-v4.1-flash", "custom-model"]);
  const raw = JSON.parse(fs.readFileSync(process.env.LLM_PROVIDERS_STORE, "utf8"));
  const models = raw.providers.find((p) => p.id === created.id).models;
  assert.deepEqual(models[0], {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    contextWindow: 128000,
    maxTokens: 32768,
    reasoningEfforts: ["low", "medium", "high"],
  });
  assert.deepEqual(models[1], { id: "custom-model", name: "Custom", contextWindow: 64000, maxTokens: 2048 });
});

test("invalid models payloads are rejected and leave the roster unchanged", () => {
  const created = llm.createProvider({ name: "Invalid Fixture", baseUrl: MOCK_BASE, apiKey: "sk-inv-key" });
  const before = JSON.parse(fs.readFileSync(process.env.LLM_PROVIDERS_STORE, "utf8"))
    .providers.find((p) => p.id === created.id).models;
  for (const bad of [
    "not-an-array",
    [{ id: "" }],
    [{ id: "a" }, { id: "a" }],
    ["bare-string"],
    [{ id: "ok", maxTokens: -5 }],
  ]) {
    assert.throws(
      () => llm.updateProvider(created.id, { models: bad }),
      (e) => e.code === "invalid",
      JSON.stringify(bad),
    );
  }
  const after = JSON.parse(fs.readFileSync(process.env.LLM_PROVIDERS_STORE, "utf8"))
    .providers.find((p) => p.id === created.id).models;
  assert.deepEqual(after, before, "roster untouched by invalid payloads");
});

test("updateProvider keeps the discovery map across a roster edit", async () => {
  const created = llm.createProvider({ name: "Discovery Keep", baseUrl: MOCK_BASE, apiKey: "sk-dk-key" });
  setBehavior({ "flagged-model": "upstream_down" });
  await llm.syncProvider(created.id);
  const withDiscovery = llm.listUserProviders().find((p) => p.id === created.id);
  assert.equal(withDiscovery.discovery["flagged-model"].status, "upstream_down");
  llm.updateProvider(created.id, { name: "Discovery Keep Renamed" });
  const after = llm.listUserProviders().find((p) => p.id === created.id);
  assert.equal(after.discovery["flagged-model"].status, "upstream_down");
});
