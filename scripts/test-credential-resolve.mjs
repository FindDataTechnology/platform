// Cascade + isolation + encryption contracts for per-owner credentials
// (openspec: add-user-supplied-credentials).
//
// The three scenarios this must pin, because each has a silent failure mode:
//   1. tool > server > user, with missing layers inheriting downward;
//   2. another owner's credential is NEVER visible through any layer;
//   3. ciphertext on disk, and no value in any projection.
//
// A DB-backed test: the store is a temp file so the real data dir is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cred-resolve-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.CREDENTIAL_SECRET = "test-credential-material";

const db = await import("../db.js");
await db.initDb();  // migrations (incl. v130) must run before any accessor
const cryptoMod = await import("../lib/credential-crypto.js");
const resolve = await import("../lib/credential-resolve.js");

test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

async function seal(v) { return cryptoMod.encryptCredential(v); }

test("cascade: tool beats server beats user", async () => {
  const owner = "a@x.io";
  db.setUserCredential(owner, "mcp:default", "api_key", await seal("user-key"));
  db.setServerCredentialOverride(owner, "srv", "api_key", await seal("server-key"));
  db.setToolCredentialOverride(owner, "srv", "tool1", "api_key", await seal("tool-key"));

  const atTool = await resolve.resolveCredentialField({
    owner, scope: "mcp:default", field: "api_key", server: "srv", tool: "tool1",
  });
  assert.equal(atTool.value, "tool-key");
  assert.equal(atTool.layer, "tool");
});

test("cascade: missing layer inherits downward", async () => {
  const owner = "b@x.io";
  db.setUserCredential(owner, "mcp:default", "api_key", await seal("user-key"));

  // no server/tool rows exist for this owner
  const viaServer = await resolve.resolveCredentialField({
    owner, scope: "mcp:default", field: "api_key", server: "srv", tool: "tool1",
  });
  assert.equal(viaServer.value, "user-key");
  assert.equal(viaServer.layer, "user");
});

test("cascade: all layers empty yields none, never someone else's value", async () => {
  const owner = "c@x.io";
  const r = await resolve.resolveCredentialField({
    owner, scope: "mcp:default", field: "api_key", server: "srv", tool: "tool1",
  });
  assert.equal(r.value, null);
  assert.equal(r.layer, "none");
});

test("isolation: owner A's credential is invisible to owner B", async () => {
  const a = "iso-a@x.io";
  const b = "iso-b@x.io";
  db.setUserCredential(a, "mcp:default", "api_key", await seal("a-key"));

  const forA = await resolve.resolveCredentialField({
    owner: a, scope: "mcp:default", field: "api_key", server: "srv",
  });
  assert.equal(forA.value, "a-key");

  const forB = await resolve.resolveCredentialField({
    owner: b, scope: "mcp:default", field: "api_key", server: "srv",
  });
  assert.equal(forB.value, null, "B must not inherit A's key");
  assert.equal(forB.layer, "none");
});

test("isolation: machine owner (null) resolves nothing", async () => {
  const r = await resolve.resolveCredentialField({
    owner: null, scope: "mcp:default", field: "api_key", server: "srv",
  });
  assert.equal(r.value, null);
  assert.equal(r.layer, "none");
});

test("encryption: stored value is an envelope, not the plaintext", async () => {
  const owner = "enc@x.io";
  const plaintext = "sk-live-should-not-be-readable";
  await db.setUserCredential(owner, "mcp:default", "api_key", await seal(plaintext));

  const row = db.getUserCredential(owner, "mcp:default", "api_key");
  assert.ok(row, "row stored");
  assert.match(row.value_encrypted, /^v1\./, "envelope versioned");
  assert.equal(
    row.value_encrypted.includes(plaintext), false,
    "plaintext must not appear in the stored value",
  );
});

test("projection: metadata only, never the value", () => {
  const proj = resolve.projectCredentialRow({
    field: "api_key", value_encrypted: "v1.a.b.c", updated_at: "2026-11-24T00:00:00Z",
  });
  assert.equal(proj.configured, true);
  assert.equal(proj.field, "api_key");
  assert.equal(Object.hasOwn(proj, "value_encrypted"), false);
});

test("resolveCredentialSet reports which layer each field came from", async () => {
  const owner = "set@x.io";
  db.setUserCredential(owner, "llm:default", "api_key", await seal("u-key"));
  db.setServerCredentialOverride(owner, "ciyuan", "url", await seal("https://u.example/v1"));

  const { values, layers } = await resolve.resolveCredentialSet({
    owner, scope: "llm:default", fields: ["api_key", "url"], server: "ciyuan",
  });
  assert.equal(values.api_key, "u-key");
  assert.equal(values.url, "https://u.example/v1");
  assert.equal(layers.api_key, "user");
  assert.equal(layers.url, "server");
});
