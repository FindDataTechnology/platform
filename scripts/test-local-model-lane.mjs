// Unit tests — the local model lane (add-local-model-lane).
// Run: node --test scripts/test-local-model-lane.mjs
//
//  1.x  keyless providers: auth "none" creates without a key; legacy records
//       read as bearer; auth validation.
//  2.x  probe/sync: auth "none" requests carry NO Authorization header;
//       bearer requests are byte-identical to before.
//  3.x  credentials: keyless providers seed an EMPTY value (route resolvable,
//       no key material); the fleet-runner inheritance holds through the
//       shared dsh profile write.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "local-lane-"));
process.env.LLM_PROVIDERS_STORE = path.join(TMP, "llm-providers.json");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.PLATFORM_DATA_DIR = TMP;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const llm = await import("../llm-providers.js");

const OLLAMA = "http://127.0.0.1:11434/v1";

test("1.1 a keyless local provider creates without any key", () => {
  const rec = llm.createProvider({ name: "Ollama Local", baseUrl: OLLAMA, auth: "none", apiKey: "" });
  assert.equal(rec.auth, "none");
  assert.equal(rec.hasKey, false);
  const raw = llm.getProviderRecord(rec.id);
  assert.equal(raw.auth, "none");
  assert.equal(raw.apiKey, "");
});

test("1.2 legacy-shaped records read as bearer (zero migration)", () => {
  // Write a record WITHOUT the auth field, the pre-lane shape.
  const doc = JSON.parse(fs.readFileSync(process.env.LLM_PROVIDERS_STORE, "utf8"));
  doc.providers.push({
    id: "legacy-cloud", name: "Legacy Cloud", baseUrl: "https://api.example.test",
    apiKey: "sk-legacy", type: "openai-completions", models: [], createdAt: "2026-01-01",
  });
  fs.writeFileSync(process.env.LLM_PROVIDERS_STORE, JSON.stringify(doc));
  const list = llm.listUserProviders();
  const legacy = list.find((p) => p.id === "legacy-cloud");
  assert.equal(legacy.auth, "bearer");
});

test("1.3 auth validation: only bearer/none; bearer requires a key", () => {
  assert.throws(
    () => llm.createProvider({ name: "Bad Auth", baseUrl: OLLAMA, auth: "magic", apiKey: "" }),
    /auth must be/,
  );
  assert.throws(
    () => llm.createProvider({ name: "Keyless Bearer", baseUrl: OLLAMA, auth: "bearer", apiKey: "" }),
    /apiKey is required/,
  );
});

test("2.1 probe on an auth=none provider sends NO Authorization header", async () => {
  const rec = llm.createProvider({ name: "Ollama Probe", baseUrl: OLLAMA, auth: "none", apiKey: "" });
  let seenHeaders = null;
  const fetchImpl = async (_url, init = {}) => {
    seenHeaders = init.headers ?? {};
    return new Response(JSON.stringify({ data: [{ id: "llama3" }] }), { status: 200 });
  };
  const out = await llm.testProvider(rec.id, { fetchImpl });
  assert.equal(out.ok, true, "the probe succeeds against a keyless server");
  assert.equal(seenHeaders.Authorization, undefined, "no Authorization header");
  assert.equal(seenHeaders.Accept, "application/json");
});

test("2.2 probe on a bearer provider keeps the header (byte-identical behaviour)", async () => {
  const rec = llm.createProvider({ name: "Cloud Probe", baseUrl: "https://api.example.test", auth: "bearer", apiKey: "sk-x" });
  let seenHeaders = null;
  const fetchImpl = async (_url, init = {}) => {
    seenHeaders = init.headers ?? {};
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  await llm.testProvider(rec.id, { fetchImpl });
  assert.equal(seenHeaders.Authorization, "Bearer sk-x");
});

test("2.3 sync on a keyless provider discovers models without credentials", async () => {
  const rec = llm.createProvider({ name: "Ollama Sync", baseUrl: OLLAMA, auth: "none", apiKey: "" });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "llama3" }, { id: "qwen2.5" }] }), { status: 200 });
    }
    // chat probe per id: a minimal serving completion
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  const out = await llm.syncProvider(rec.id, { fetchImpl });
  // The response carries the per-id status map; both local ids must be serving.
  const servingIds = Object.entries(out.statuses ?? {})
    .filter(([, r]) => r?.status === "serving")
    .map(([id]) => id);
  assert.ok(servingIds.includes("llama3") && servingIds.includes("qwen2.5"), JSON.stringify(out.statuses));
  for (const call of calls) {
    assert.equal(call.headers.Authorization, undefined, `no Authorization header to ${call.url}`);
  }
  const after = llm.listUserProviders().find((p) => p.id === rec.id);
  assert.ok(after.models.includes("llama3"), "serving models merged into the roster");
});

test("3.1 keyless providers seed an EMPTY credential value (no key material)", () => {
  const refs = llm.credentialRefsForUserProviders();
  const rec = llm.getProviderRecord(
    llm.listUserProviders().find((p) => p.auth === "none").id,
  );
  const envRef = llm.envRefForProvider(rec.id);
  assert.equal(refs[envRef], "", "empty value — the ref stays resolvable with no key material");
  const cloud = llm.listUserProviders().find((p) => p.auth === "bearer" && p.hasKey);
  const cloudRef = llm.envRefForProvider(cloud.id);
  assert.notEqual(refs[cloudRef], "", "bearer providers keep their key");
});

test("3.2 the runner inherits the local lane through the shared dsh profile write", async () => {
  // The same writeLlmProfile the cell chat lane uses — the fleet runner's seed
  // home is the SAME dsh home, so the route must appear there with the local
  // provider's baseUrl and an empty credential entry.
  const local = llm.listUserProviders().find((p) => p.auth === "none");
  llm.setDefault({ providerId: local.id, modelId: "llama3" });
  await (await import("../dsh-profile.js")).writeLlmProfile();
  const credsPath = path.join(process.env.DSH_HOME, ".credentials.yaml");
  const creds = fs.existsSync(credsPath) ? fs.readFileSync(credsPath, "utf8") : "";
  const envRef = llm.envRefForProvider(local.id);
  if (creds) {
    // The entry may exist but MUST be empty for the keyless lane.
    const line = creds.split("\n").find((l) => l.includes(envRef));
    if (line) assert.match(line, /:\s*(['"])?\1?\s*$/, `keyless credential entry must be empty: ${line}`);
  }
  // writeLlmProfile upserts the llm-pi-ai row in the profile's cordis.patch.yml
  // — the file the runner's seed home carries. Parse it and assert the local
  // route (baseUrl + models) is visible to the runner side, keyless.
  const yaml = (await import("js-yaml")).default;
  const patchPath = path.join(process.env.DSH_HOME, "profiles", "platform", "cordis.patch.yml");
  const rows = yaml.load(fs.readFileSync(patchPath, "utf8"));
  const row = (Array.isArray(rows) ? rows : []).find((r) => r?.id === "llm-pi-ai");
  assert.ok(row, "the llm-pi-ai row exists in the profile patch");
  const entry = row.config?.providers?.[local.id];
  assert.equal(entry?.baseURL, OLLAMA, "the local route reaches the runner-side profile");
  assert.ok(Array.isArray(entry?.models) && entry.models.length > 0, "the roster rides along");
});
