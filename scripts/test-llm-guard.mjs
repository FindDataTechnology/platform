// Unit tests for the default-lane guard (add-editable-llm-route, task 3.1):
//   - definitive dark (the gateway's model_not_found body) → default pointer
//     switches to the first known-serving model, ctx.defaultModel updates,
//     `model_fallback` broadcasts
//   - network error / timeout → default kept, no broadcast
//   - no serving model known → default kept, outcome surfaced (noFallback)
//   - both route shapes resolve credentials: the reserved env route
//     (override-aware base URL) and a user-managed provider record
//
// Stores are redirected to a temp dir so real user data is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-guard-"));
process.env.LLM_PROVIDERS_STORE = path.join(tmpRoot, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(tmpRoot, "llm-default.json");
process.env.LLM_API_KEY = "sk-guard";

const llm = await import("../llm-providers.js");
const { guardDefaultLane } = await import("../server/llm-guard.js");

// ── Mock gateway ─────────────────────────────────────────────────────────────
const mock = await new Promise((resolve) => {
  const behavior = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const model = JSON.parse(Buffer.concat(chunks).toString()).model;
        if (behavior[model] === "ok") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
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
  server.listen(0, "127.0.0.1", () => resolve({ server, behavior, url: `http://127.0.0.1:${server.address().port}` }));
});
test.after(() => mock.server.close());
const setBehavior = (map) => {
  for (const k of Object.keys(mock.behavior)) delete mock.behavior[k];
  Object.assign(mock.behavior, map);
};

const ctxFixture = (dshModels, defaultModel) => {
  const events = [];
  return {
    ctx: { dshModels, defaultModel, broadcast: (e) => events.push(e) },
    events,
  };
};

test("dark default falls back to the first known-serving model and broadcasts", async () => {
  // The reserved route's discovery lives on the override; the env lane serves glm.
  llm.setVolcesOverride({
    baseUrl: mock.url,
    models: [
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 32768 },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 128000, maxTokens: 32768 },
    ],
    discovery: {
      "deepseek-v4.1-flash": { status: "serving" },
      "glm-5.3-flash": { status: "serving" },
    },
  });
  setBehavior({ "deepseek-v4.1-flash": "unauthorized", "glm-5.3-flash": "ok" });

  const { ctx, events } = ctxFixture(
    [
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "volces" },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "volces" },
    ],
    { id: "deepseek-v4.1-flash", provider: "volces", name: "DeepSeek V4.1 Flash" }
  );
  const outcome = await guardDefaultLane(ctx, { reason: "boot" });
  assert.equal(outcome.action, "fell_back");
  assert.equal(outcome.from, "deepseek-v4.1-flash");
  assert.equal(outcome.to, "glm-5.3-flash");
  assert.equal(ctx.defaultModel.id, "glm-5.3-flash");
  assert.equal(llm.getDefault().modelId, "glm-5.3-flash");
  assert.equal(llm.getDefault().providerId, "volces");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "model_fallback");
  assert.equal(events[0].from, "deepseek-v4.1-flash");
  assert.equal(events[0].to, "glm-5.3-flash");
  llm.clearVolcesOverride();
});

test("network error keeps the default, no broadcast", async () => {
  llm.setVolcesOverride({
    baseUrl: "http://127.0.0.1:9/v1", // nothing listens here
    models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 32768 }],
  });
  const { ctx, events } = ctxFixture(
    [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "volces" }],
    { id: "deepseek-v4.1-flash", provider: "volces", name: "DeepSeek V4.1 Flash" }
  );
  const outcome = await guardDefaultLane(ctx);
  assert.equal(outcome.action, "kept");
  assert.equal(outcome.probe, "network_error");
  assert.equal(events.length, 0);
  assert.equal(ctx.defaultModel.id, "deepseek-v4.1-flash");
  llm.clearVolcesOverride();
});

test("no serving model known keeps the default surfaced", async () => {
  llm.setVolcesOverride({
    baseUrl: mock.url,
    models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, maxTokens: 32768 }],
    discovery: { "deepseek-v4.1-flash": { status: "unauthorized" } },
  });
  setBehavior({ "deepseek-v4.1-flash": "unauthorized" });
  const { ctx, events } = ctxFixture(
    [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "volces" }],
    { id: "deepseek-v4.1-flash", provider: "volces", name: "DeepSeek V4.1 Flash" }
  );
  const outcome = await guardDefaultLane(ctx);
  assert.equal(outcome.action, "kept");
  assert.equal(outcome.noFallback, true);
  assert.equal(events.length, 0);
  llm.clearVolcesOverride();
});

test("user-provider default resolves its own credentials and falls back across routes", async () => {
  llm.setVolcesOverride({
    baseUrl: mock.url,
    models: [{ id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 128000, maxTokens: 32768 }],
    discovery: { "glm-5.3-flash": { status: "serving" } },
  });
  setBehavior({ "user-dark": "unauthorized", "glm-5.3-flash": "ok" });
  const created = llm.createProvider({ name: "Guard Aux", baseUrl: mock.url, apiKey: "sk-aux" });
  llm.updateProvider(created.id, {
    models: [{ id: "user-dark" }],
  });
  // Seed the user provider's discovery so the fallback scan sees the volces lane.
  const doc = JSON.parse(fs.readFileSync(process.env.LLM_PROVIDERS_STORE, "utf8"));
  const rec = doc.providers.find((p) => p.id === created.id);
  rec.discovery = { "user-dark": { status: "unauthorized" }, "glm-5.3-flash": { status: "serving" } };
  fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify(doc));

  const { ctx, events } = ctxFixture(
    [
      { id: "user-dark", name: "User Dark", provider: created.id },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "volces" },
    ],
    { id: "user-dark", provider: created.id, name: "User Dark" }
  );
  const outcome = await guardDefaultLane(ctx);
  assert.equal(outcome.action, "fell_back");
  assert.equal(outcome.to, "glm-5.3-flash");
  assert.equal(llm.getDefault().providerId, "volces");
  assert.equal(events[0].type, "model_fallback");
  llm.clearVolcesOverride();
});
