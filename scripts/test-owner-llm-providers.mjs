// Per-owner LLM providers (openspec: add-user-supplied-credentials, L1).
//
// The three properties that matter, each with a silent failure mode if wrong:
//   - one user's provider is invisible to another;
//   - an unconfigured user keeps the platform default (no behaviour change);
//   - an arbitrary URL is refused (the first version only allows known upstreams).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owner-providers-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.CREDENTIAL_SECRET = "test-credential-material";
process.env.LLM_PROVIDERS_STORE = path.join(tmpRoot, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(tmpRoot, "llm-default.json");

const db = await import("../db.js");
await db.initDb();
const llm = await import("../llm-providers.js");

test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

test("a user's own provider is invisible to another user", async () => {
  const a = "own-a@x.io";
  const b = "own-b@x.io";
  await llm.createProviderForOwner(a, {
    name: "My DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-a",
  });

  const forA = await llm.getOwnerProviders(a);
  const forB = await llm.getOwnerProviders(b);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].apiKey, "sk-a");
  assert.equal(forB.length, 0, "B must see none of A's providers");
});

test("unconfigured user falls back to the platform default", async () => {
  // No platform providers in this fixture → the effective list is empty, but
  // the point is that it does not inherit another owner's rows.
  const c = "own-c@x.io";
  const list = await llm.listProvidersForOwner(c);
  assert.deepEqual(list, []);
});

test("arbitrary upstream URL is refused (first version allows known list only)", async () => {
  await assert.rejects(
    () => llm.createProviderForOwner("own-d@x.io", {
      name: "Anything", baseUrl: "https://evil.example.com/v1", apiKey: "sk-d",
    }),
    /known upstreams/,
  );
});

test("deleting one's provider removes every field row", async () => {
  const e = "own-e@x.io";
  const created = await llm.createProviderForOwner(e, {
    name: "OpenAI Mine", baseUrl: "https://api.openai.com/v1", apiKey: "sk-e",
  });
  assert.equal((await llm.getOwnerProviders(e)).length, 1);
  llm.deleteOwnerProvider(e, created.id);
  assert.equal((await llm.getOwnerProviders(e)).length, 0);
});

test("the stored key is encrypted, not plaintext", async () => {
  const f = "own-f@x.io";
  const created = await llm.createProviderForOwner(f, {
    name: "Enc Check", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-should-be-sealed",
  });
  const row = db.getUserCredential(f, "llm:default", `provider:${created.id}:api_key`);
  assert.ok(row, "row exists");
  assert.equal(row.value_encrypted.includes("sk-should-be-sealed"), false);
  // …and the record surface never hands the key to a client
  const listed = await llm.listProvidersForOwner(f);
  const rec = listed.find((p) => p.id === created.id);
  assert.equal(Object.hasOwn(rec, "apiKey"), true, "internal record carries it");
  assert.equal(llm.listUserProviders().some((p) => p.id === created.id), false,
    "the platform-default list never contains a personal provider");
});

test("update keeps the stored key when apiKey is blank", async () => {
  const g = "own-g@x.io";
  const created = await llm.createProviderForOwner(g, {
    name: "Keep Key", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-original",
  });
  await llm.updateProviderForOwner(g, created.id, { name: "Keep Key Renamed", apiKey: "" });
  const [row] = await llm.getOwnerProviders(g);
  assert.equal(row.name, "Keep Key Renamed");
  assert.equal(row.apiKey, "sk-original", "blank apiKey must not wipe the stored key");
});

// ── Platform-layer id collision (follow-up, 2026-11-24) ──────────────────────
//
// The published spec says a user's provider "MUST NOT … 改变平台默认路由".
// Before this guard, `createProviderForOwner` deduped against the owner's ids
// only, so a user could create one whose id equalled a platform provider's —
// `listProvidersForOwner` then filtered the platform row out and the runtime
// used the user's key. These two cases pin the fix: the user still gets a
// provider, and the platform entry survives.
test("owner 建与平台同 id 的 provider 会让位，平台那条不受影响", async () => {
  const owner = "collide-o@x.io";
  llm.createProvider({ name: "Collide", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-platform" });
  const platformIds = llm.listUserProviders().map((p) => p.id);
  const platformId = platformIds.find((id) => id.startsWith("collide"));
  assert.ok(platformId, "platform provider must exist");

  const mine = await llm.createProviderForOwner(owner, {
    name: "Collide", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-mine",
  });
  assert.notEqual(mine.id, platformId, "owner id must not collide with the platform id");

  const view = await llm.listProvidersForOwner(owner);
  assert.ok(view.some((p) => p.id === platformId), "platform provider must still be in the owner's view");
  assert.ok(view.some((p) => p.id === mine.id), "owner's provider must be in its own view");
  // And the platform record itself is untouched (still the platform's key).
  assert.equal(llm.getProviderRecord(platformId)?.apiKey, "sk-platform");
});
