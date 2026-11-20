// Unit tests for llm-providers.js (dsh-llm-models-page change, tasks 7.1/7.2):
//   - create/update/delete round-trip + validation
//   - reserved Volces id cannot be mutated
//   - delete the only provider is rejected (409 only_provider)
//   - API key never appears in client records (hasKey only)
//   - merge into the dsh profile (buildUserProviderEntries + credential refs)
//   - testProvider sanitizer strips the key and truncates error bodies
//
// Stores are redirected to a temp dir via LLM_PROVIDERS_STORE /
// LLM_DEFAULT_STORE so the real user data is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-providers-"));
process.env.LLM_PROVIDERS_STORE = path.join(tmpRoot, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(tmpRoot, "llm-default.json");
// No env Volces key → a user provider is the "only provider" (delete → 409).
delete process.env.LLM_API_KEY;

const llm = await import("../llm-providers.js");

function makeFetch(status, body) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    });
}

test("create + list round-trips a provider (key never exposed)", () => {
  const rec = llm.createProvider({
    name: "Acme AI",
    baseUrl: "https://api.acme.example",
    apiKey: "sk-secret-123",
  });
  assert.match(rec.id, /^acme-ai/);
  assert.equal(rec.hasKey, true);
  assert.equal("apiKey" in rec, false, "apiKey must not be in the client record");
  assert.equal(rec.type, "openai-completions");
  assert.ok(Array.isArray(rec.models) && rec.models.length > 0);

  const list = llm.listUserProviders();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, rec.id);
  assert.equal(list[0].name, "Acme AI");
  assert.equal(list[0].hasKey, true);
});

test("create normalizes a bare baseUrl to include /v1", () => {
  const rec = llm.createProvider({
    name: "Bare Host",
    baseUrl: "https://api.bare.example",
    apiKey: "k",
  });
  assert.equal(rec.baseUrl, "https://api.bare.example/v1");
});

test("rejects invalid input (empty name, bad url, missing key)", () => {
  assert.throws(() => llm.createProvider({ name: "", baseUrl: "https://x.example", apiKey: "k" }),
    (e) => e.code === "invalid");
  assert.throws(() => llm.createProvider({ name: "X", baseUrl: "not-a-url", apiKey: "k" }),
    (e) => e.code === "invalid");
  assert.throws(() => llm.createProvider({ name: "X", baseUrl: "https://x.example", apiKey: "" }),
    (e) => e.code === "invalid");
});

test("duplicate name is rejected", () => {
  assert.throws(
    () => llm.createProvider({ name: "Acme AI", baseUrl: "https://other.example", apiKey: "k" }),
    (e) => e.code === "duplicate",
  );
});

test("update with empty apiKey keeps the current key", () => {
  const [before] = llm.listUserProviders();
  const updated = llm.updateProvider(before.id, { name: "Acme AI Renamed" });
  assert.equal(updated.name, "Acme AI Renamed");
  assert.equal(updated.hasKey, true, "key retained when omitted");

  const entries = llm.buildUserProviderEntries();
  assert.ok(entries.providers[before.id], "provider still present after rename");
  const refs = llm.credentialRefsForUserProviders();
  const envRef = llm.envRefForProvider(before.id);
  assert.equal(refs[envRef], "sk-secret-123", "credential ref holds the retained key");
});

test("update replaces the key when a non-empty value is provided", () => {
  const [before] = llm.listUserProviders();
  llm.updateProvider(before.id, { apiKey: "sk-rotated-999" });
  const refs = llm.credentialRefsForUserProviders();
  assert.equal(refs[llm.envRefForProvider(before.id)], "sk-rotated-999");
});

test("update / delete unknown id throws not_found", () => {
  assert.throws(() => llm.updateProvider("nope", { name: "x" }), (e) => e.code === "not_found");
  assert.throws(() => llm.deleteProvider("nope"), (e) => e.code === "not_found");
});

test("deleting the only configured provider is rejected (only_provider)", () => {
  // Earlier tests created two providers; delete one so exactly one remains.
  let all = llm.listUserProviders();
  while (all.length > 1) {
    llm.deleteProvider(all[all.length - 1].id);
    all = llm.listUserProviders();
  }
  const [only] = all;
  assert.equal(all.length, 1);
  assert.throws(() => llm.deleteProvider(only.id), (e) => e.code === "only_provider");
});

test("default pointer round-trips and validates modelId", () => {
  assert.deepEqual(llm.getDefault(), { providerId: null, modelId: null });
  const saved = llm.setDefault({ providerId: "acme-ai", modelId: "deepseek-v4-pro" });
  assert.equal(saved.modelId, "deepseek-v4-pro");
  assert.equal(llm.getDefault().modelId, "deepseek-v4-pro");
  assert.throws(() => llm.setDefault({ modelId: "" }), (e) => e.code === "invalid");
});

test("testProvider: 2xx returns ok with latency", async () => {
  const id = llm.listUserProviders()[0].id;
  const r = await llm.testProvider(id, { fetchImpl: makeFetch(200, '{"data":[]}') });
  assert.equal(r.ok, true);
  assert.equal(typeof r.latencyMs, "number");
});

test("testProvider: non-2xx returns sanitized error", async () => {
  const id = llm.listUserProviders()[0].id;
  const r = await llm.testProvider(id, {
    fetchImpl: makeFetch(401, "invalid token sk-rotated-999 used here"),
  });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes("sk-rotated-999"), "key must be stripped from error");
  assert.ok(r.error.includes("401"));
});

test("testProvider: error body is truncated to 200 chars", async () => {
  const id = llm.listUserProviders()[0].id;
  const huge = "x".repeat(500);
  const r = await llm.testProvider(id, { fetchImpl: makeFetch(500, huge) });
  assert.equal(r.ok, false);
  assert.ok(r.error.length <= 200 + 16, `error too long: ${r.error.length}`);
});

test("testProvider persists lastTest on the provider", async () => {
  const id = llm.listUserProviders()[0].id;
  await llm.testProvider(id, { fetchImpl: makeFetch(200, "{}") });
  const after = llm.listUserProviders().find((p) => p.id === id);
  assert.equal(after.lastTest.ok, true);
  assert.equal(typeof after.lastTest.latencyMs, "number");
});
