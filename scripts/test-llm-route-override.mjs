// Unit tests for the reserved-route override (add-editable-llm-route, tasks
// 1.1–1.3 / 2.1):
//   - override doc: absent → null, write→read round-trip, survives a
//     user-provider mutation (sibling key, one write chain), clear → rollback
//   - updateProvider("volces"): {baseUrl?, models?} accepted (+ URL
//     normalization and models validation), apiKey/name rejected with the
//     reserved-semantics error, empty patch rejected, deleteProvider refused
//   - syncProvider("volces"): the dry run is gone — serving ids merge into the
//     override roster with family metadata, an existing non-serving id
//     survives flagged (no evict), the discovery map persists, the response
//     has no dryRun marker
//   - effectiveVolcesRoute / buildLlmProfile: override > env > baked
//     precedence for roster and base URL; without an override the projection
//     is identical to the seed (baked roster, caller base URL)
//
// Stores are redirected to a temp dir via LLM_PROVIDERS_STORE so real user
// data is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-route-override-"));
process.env.LLM_PROVIDERS_STORE = path.join(tmpRoot, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(tmpRoot, "llm-default.json");
delete process.env.LLM_API_KEY;

const llm = await import("../llm-providers.js");
const dshProfile = await import("../dsh-profile.js");

// ── Mock gateway ─────────────────────────────────────────────────────────────
// GET /v1/models lists the behavior map's keys; POST /v1/chat/completions
// answers per id: "ok" | "unauthorized". Buckets mirror the real gateway's
// response shapes (probeModel / classifyResponse contracts).

const mock = await new Promise((resolve) => {
  const behavior = {};
  const server = http.createServer((req, res) => {
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
        if (behavior[model] === "ok") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            })
          );
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: `Model "${model}" is not supported by any configured account in this group`,
                type: "model_not_found",
              },
            })
          );
        }
        return;
      }
      res.writeHead(404).end();
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, behavior, url: `http://127.0.0.1:${server.address().port}/v1` }));
});

test.after(() => mock.server.close());

const setBehavior = (map) => {
  for (const k of Object.keys(mock.behavior)) delete mock.behavior[k];
  Object.assign(mock.behavior, map);
};
const setEnv = (patch) => Object.assign(process.env, patch);
const withEnv = async (patch, fn) => {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  setEnv(patch);
  try {
    return await fn();
  } finally {
    setEnv(saved);
  }
};

// ── 1.1 Override doc ─────────────────────────────────────────────────────────

test("override doc: absent reads null, write round-trips, clear rolls back", () => {
  assert.equal(llm.getVolcesOverride(), null);
  const written = llm.setVolcesOverride({ models: [{ id: "m1", name: "M1", contextWindow: 128000, maxTokens: 8192 }] });
  assert.equal(written.models.length, 1);
  assert.equal(written.models[0].id, "m1");
  assert.ok(written.updatedAt);
  assert.equal(llm.clearVolcesOverride(), true);
  assert.equal(llm.getVolcesOverride(), null);
  assert.equal(llm.clearVolcesOverride(), false);
});

test("override doc: survives a user-provider mutation (sibling key, one chain)", () => {
  llm.setVolcesOverride({ baseUrl: "http://gw.example/v1" });
  // envCount: the env route must exist for the delete to clear the aux row.
  const savedKey = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "k";
  let created;
  try {
    created = llm.createProvider({ name: "Aux", baseUrl: "http://aux.example/v1", apiKey: "k" });
  } finally {
    process.env.LLM_API_KEY = savedKey;
  }
  assert.ok(created.id);
  const ov = llm.getVolcesOverride();
  assert.equal(ov.baseUrl, "http://gw.example/v1");
  assert.equal(llm.listUserProviders().length, 1);
  const savedKey2 = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "k";
  try {
    llm.deleteProvider(created.id);
  } finally {
    process.env.LLM_API_KEY = savedKey2;
  }
  assert.equal(llm.getVolcesOverride()?.baseUrl, "http://gw.example/v1");
  llm.clearVolcesOverride();
});

// ── 1.2 Reserved-gate narrowing ──────────────────────────────────────────────

test("updateProvider(volces) accepts models and persists into the override", () => {
  const rec = llm.updateProvider("volces", {
    models: [{ id: "deepseek-v4.1-flash" }, { id: "extra-id", contextWindow: 64000, maxTokens: 4096 }],
  });
  assert.equal(rec.id, "volces");
  assert.ok(rec.reserved);
  const ov = llm.getVolcesOverride();
  assert.equal(ov.models.length, 2);
  const extra = ov.models.find((m) => m.id === "extra-id");
  assert.equal(extra.contextWindow, 64000);
  assert.equal(extra.maxTokens, 4096);
  // Absent per-entry fields fall back to the family table / defaults.
  const ds = ov.models.find((m) => m.id === "deepseek-v4.1-flash");
  assert.equal(ds.maxTokens, 32768);
  llm.clearVolcesOverride();
});

test("updateProvider(volces) accepts and normalizes baseUrl", () => {
  const rec = llm.updateProvider("volces", { baseUrl: "http://gw.example" });
  assert.equal(rec.override.baseUrl, "http://gw.example/v1");
  llm.clearVolcesOverride();
});

test("updateProvider(volces) rejects apiKey/name and empty patches; delete refused", () => {
  assert.throws(() => llm.updateProvider("volces", { apiKey: "sk-x" }), /env-owned/);
  assert.throws(() => llm.updateProvider("volces", { name: "X" }), /not editable/);
  assert.throws(() => llm.updateProvider("volces", {}), /nothing to update/);
  assert.throws(() => llm.updateProvider("volces", { models: [{ id: "" }] }), /model id is required/);
  assert.throws(() => llm.deleteProvider("volces"), /reserved provider id/);
  assert.equal(llm.getVolcesOverride(), null);
});

// ── 1.3 Reserved sync persists ───────────────────────────────────────────────

test("syncProvider(volces) merges serving ids into the override (no dry run)", async () => {
  llm.setVolcesOverride({
    models: [
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 32768 },
      { id: "dark-id", name: "Dark", contextWindow: 128000, maxTokens: 8192 },
    ],
  });
  setBehavior({ "deepseek-v4.1-flash": "ok", "dark-id": "unauthorized", "glm-5.3-flash": "ok" });
  const result = await withEnv(
    { LLM_API_KEY: "k", LLM_BASE_URL: mock.url },
    () => llm.syncProvider("volces")
  );
  assert.equal(result.dryRun, undefined);
  assert.deepEqual(result.added.sort(), ["glm-5.3-flash"]);
  assert.equal(result.statuses["dark-id"].status, "unauthorized");
  const ov = llm.getVolcesOverride();
  assert.equal(ov.models.length, 3);
  // No evict: the dark id survives, flagged in the persisted discovery map.
  assert.ok(ov.models.some((m) => m.id === "dark-id"));
  assert.equal(ov.discovery["dark-id"].status, "unauthorized");
  // New id carries family metadata (glm lane).
  const glm = ov.models.find((m) => m.id === "glm-5.3-flash");
  assert.equal(glm.maxTokens, 32768);
  llm.clearVolcesOverride();
});

test("syncProvider(volces) without an env key is invalid", async () => {
  await assert.rejects(
    withEnv({ LLM_API_KEY: "" }, () => llm.syncProvider("volces")),
    /reserved route has no API key/
  );
});

// ── 2.1 Projection precedence ────────────────────────────────────────────────

test("effectiveVolcesRoute: override wins over env and baked values", async () => {
  llm.setVolcesOverride({ baseUrl: "http://override-gw.example/v1", models: [{ id: "only-id", name: "Only", contextWindow: 1000, maxTokens: 100 }] });
  const eff = await withEnv({ LLM_BASE_URL: "http://env-gw.example/v1" }, () => dshProfile.effectiveVolcesRoute());
  assert.equal(eff.hasOverride, true);
  assert.equal(eff.baseURL, "http://override-gw.example/v1");
  assert.equal(eff.models.length, 1);
  assert.equal(eff.models[0].id, "only-id");
  llm.clearVolcesOverride();
});

test("buildLlmProfile: override reshapes the volces route; seed stays identical without one", async () => {
  const seeded = await withEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "http://env-gw.example/v1" }, () =>
    dshProfile.buildLlmProfile({ llmApiKey: "k", llmBaseUrl: "http://env-gw.example/v1" })
  );
  assert.equal(seeded.providers.volces.baseURL, "http://env-gw.example/v1");
  const bakedIds = seeded.providers.volces.models.map((m) => m.id);
  assert.ok(bakedIds.includes("deepseek-v4.1-flash"));
  assert.ok(seeded.models.some((m) => m.provider === "volces" && m.id === "deepseek-v4.1-flash"));

  llm.setVolcesOverride({ baseUrl: "http://override-gw.example", models: [{ id: "ov-id", name: "OV", contextWindow: 8000, maxTokens: 512 }] });
  const overridden = await withEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "http://env-gw.example/v1" }, () =>
    dshProfile.buildLlmProfile({ llmApiKey: "k", llmBaseUrl: "http://env-gw.example/v1" })
  );
  assert.equal(overridden.providers.volces.baseURL, "http://override-gw.example/v1");
  assert.deepEqual(overridden.providers.volces.models.map((m) => m.id), ["ov-id"]);
  assert.ok(overridden.models.some((m) => m.provider === "volces" && m.id === "ov-id"));
  assert.ok(!overridden.models.some((m) => m.provider === "volces" && m.id === "deepseek-v4.1-flash"));
  llm.clearVolcesOverride();
});

// ── 2.2 Route surface (GET only — mutation routes hot-reload the live dsh
// profile and are covered by module tests above + e2e) ──────────────────────

import express from "express";
import { createServer as createHttpServer } from "node:http";
import { registerLlmRoutes } from "../server/routes/llm.js";

function routeApp(dshModels) {
  const app = express();
  app.use(express.json());
  registerLlmRoutes({
    app,
    broadcast: () => {},
    ready: { dsh: true },
    dshModels,
    getAvailableModels: async () => dshModels,
    requireAdmin: () => true,
    defaultModel: null,
    session: null,
    refreshDshModels: async () => dshModels,
  });
  return app;
}

async function call(app, method, path) {
  const server = createHttpServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const volcesModels = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "volces" },
  { id: "cohere/north-mini-code:free", name: "Cohere", provider: "volces" },
];

test("GET /api/llm/providers projects the effective reserved lane + override indicator", async () => {
  const app = routeApp(volcesModels);
  const seeded = await withEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "http://env-gw.example/v1" }, () =>
    call(app, "GET", "/api/llm/providers")
  );
  assert.equal(seeded.status, 200);
  const volces = seeded.body.providers.find((p) => p.id === "volces");
  assert.ok(volces.reserved);
  assert.equal(volces.baseUrl, "http://env-gw.example/v1");
  assert.equal(volces.override.active, false);
  assert.equal(volces.override.rosterSize, 0);
  assert.deepEqual(volces.models, ["deepseek-v4.1-flash", "cohere/north-mini-code:free"]);

  llm.setVolcesOverride({ baseUrl: "http://override-gw.example" });
  const overridden = await withEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "http://env-gw.example/v1" }, () =>
    call(app, "GET", "/api/llm/providers")
  );
  const volces2 = overridden.body.providers.find((p) => p.id === "volces");
  assert.equal(volces2.baseUrl, "http://override-gw.example/v1");
  assert.equal(volces2.override.active, true);
  assert.equal(volces2.override.baseUrl, "http://override-gw.example/v1");
  llm.clearVolcesOverride();
});

// ── 3.2 Runtime trigger wiring (PUT /api/llm/default runs the guard) ────────

test("PUT /api/llm/default on a dark model triggers the fallback broadcast", async () => {
  llm.setVolcesOverride({
    baseUrl: mock.url,
    models: [
      { id: "dark-id", name: "Dark", contextWindow: 128000, maxTokens: 8192 },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 128000, maxTokens: 32768 },
    ],
    discovery: { "dark-id": { status: "serving" }, "glm-5.3-flash": { status: "serving" } },
  });
  setBehavior({ "dark-id": "unauthorized", "glm-5.3-flash": "ok" });

  const events = [];
  const app = express();
  app.use(express.json());
  registerLlmRoutes({
    app,
    broadcast: (e) => events.push(e),
    ready: { dsh: true },
    dshModels: [
      { id: "dark-id", name: "Dark", provider: "volces" },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "volces" },
    ],
    getAvailableModels: async () => [],
    requireAdmin: () => true,
    defaultModel: { id: "glm-5.3-flash", provider: "volces", name: "GLM 5.3 Flash" },
    session: { model: { id: "glm-5.3-flash" } },
    refreshDshModels: async () => [],
  });

  const res = await withEnv({ LLM_API_KEY: "k" }, () =>
    call(app, "PUT", "/api/llm/default").then(async (r) => r)
  );
  assert.equal(res.status, 400 || 200, "PUT without body is rejected before the guard");

  // The guarded path: set the dark default, then await the fire-and-forget
  // guard long enough for its probe round-trip.
  const server = createHttpServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const put = await fetch(`http://127.0.0.1:${server.address().port}/api/llm/default`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "dark-id" }),
    });
    assert.equal(put.status, 200);
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await new Promise((r) => server.close(r));
  }
  const fallbackEvent = events.find((e) => e.type === "model_fallback");
  assert.ok(fallbackEvent, "guard broadcast the substitution");
  assert.equal(fallbackEvent.from, "dark-id");
  assert.equal(fallbackEvent.to, "glm-5.3-flash");
  assert.equal(llm.getDefault().modelId, "glm-5.3-flash");
  llm.clearVolcesOverride();
});
