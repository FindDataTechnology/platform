// L4 — tool-level credentials (openspec: add-user-supplied-credentials, D4).
//
// The property under test is not "a value round-trips" but "a value that can
// never take effect is REFUSED". MCP gives one server one credential per
// connection, so a per-tool key is only meaningful when the server declares
// both the capability and the env destination.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tool-creds-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.CREDENTIAL_SECRET = "test-credential-material";

const db = await import("../db.js");
await db.initDb();
const tc = await import("../lib/tool-credentials.js");

test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

const SUPPORTED = {
  credentialScopes: ["user", "server", "tool"],
  toolCredentialEnv: { wire_content_search: "WIRE_CONTENT_TOKEN" },
};
const WITHOUT_TOOL = { credentialScopes: ["user", "server"] };
const NO_DECLARATION = {};

test("a server without the declaration is refused, not silently stored", async () => {
  assert.equal(tc.supportsToolCredentials(NO_DECLARATION), false);
  await assert.rejects(
    () => tc.setToolCredential({
      owner: "a@x.io", serverName: "wire-ops", serverConfig: NO_DECLARATION,
      toolName: "wire_content_search", apiKey: "k",
    }),
    /does not support per-tool credentials/,
  );
  assert.deepEqual(db.listToolCredentialOverrides("a@x.io", "wire-ops"), []);
});

test("a tool with no declared env destination is refused", async () => {
  await assert.rejects(
    () => tc.setToolCredential({
      owner: "b@x.io", serverName: "wire-ops", serverConfig: WITHOUT_TOOL,
      toolName: "wire_content_search", apiKey: "k",
    }),
    /does not support per-tool credentials/,
  );
  await assert.rejects(
    () => tc.setToolCredential({
      owner: "b@x.io", serverName: "wire-ops", serverConfig: SUPPORTED,
      toolName: "some_other_tool", apiKey: "k",
    }),
    /no env destination/,
  );
});

test("a declared tool resolves into the env var the manifest names", async () => {
  const owner = "c@x.io";
  await tc.setToolCredential({
    owner, serverName: "wire-ops", serverConfig: SUPPORTED,
    toolName: "wire_content_search", apiKey: "tool-secret",
  });
  const { values } = await tc.resolveToolCredentials({
    owner, serverName: "wire-ops", serverConfig: SUPPORTED,
  });
  assert.equal(values.WIRE_CONTENT_TOKEN, "tool-secret");
});

test("another owner's tool credential is invisible", async () => {
  await tc.setToolCredential({
    owner: "d1@x.io", serverName: "wire-ops", serverConfig: SUPPORTED,
    toolName: "wire_content_search", apiKey: "d1-secret",
  });
  const { values } = await tc.resolveToolCredentials({
    owner: "d2@x.io", serverName: "wire-ops", serverConfig: SUPPORTED,
  });
  assert.deepEqual(values, {});
});

test("clearing removes the override", async () => {
  const owner = "e@x.io";
  await tc.setToolCredential({
    owner, serverName: "wire-ops", serverConfig: SUPPORTED,
    toolName: "wire_content_search", apiKey: "tmp",
  });
  assert.ok(Object.keys((await tc.resolveToolCredentials({
    owner, serverName: "wire-ops", serverConfig: SUPPORTED,
  })).values).length);
  await tc.setToolCredential({
    owner, serverName: "wire-ops", serverConfig: SUPPORTED,
    toolName: "wire_content_search", apiKey: "",
  });
  assert.deepEqual((await tc.resolveToolCredentials({
    owner, serverName: "wire-ops", serverConfig: SUPPORTED,
  })).values, {});
});

test("stored value is encrypted; projection carries metadata only", async () => {
  const owner = "f@x.io";
  await tc.setToolCredential({
    owner, serverName: "wire-ops", serverConfig: SUPPORTED,
    toolName: "wire_content_search", apiKey: "plain-secret",
  });
  const [row] = db.listToolCredentialOverrides(owner, "wire-ops");
  assert.equal(row.value_encrypted.includes("plain-secret"), false);
  const proj = tc.projectToolCredentials({ owner, serverName: "wire-ops", serverConfig: SUPPORTED });
  assert.equal(proj.supported, true);
  assert.equal(proj.tools.wire_content_search.configured, true);
  assert.equal(JSON.stringify(proj).includes("plain-secret"), false);
});
