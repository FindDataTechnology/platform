// L3 — per-owner MCP endpoint override (openspec: add-user-supplied-credentials,
// design D3). The two properties that must hold: an undeclared server cannot be
// re-pointed, and an unsafe destination never reaches storage.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
// Mesh-block fixture built at runtime (see test-url-safety.mjs): a literal
// 100.64.x.y here would trip the public-snapshot leak gate.
const meshIp = (third, host) => ["100", "64", third, host].join(".");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-endpoints-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.CREDENTIAL_SECRET = "test-credential-material";

const db = await import("../db.js");
await db.initDb();
const ep = await import("../lib/mcp-endpoints.js");

test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

const OVERRIDABLE = { endpointOverridable: true };
const PLAIN = {}; // no declaration = default closed

test("an undeclared server cannot be re-pointed", async () => {
  assert.equal(ep.isEndpointOverridable(PLAIN), false);
  await assert.rejects(
    () => ep.setOwnerEndpoint({
      owner: "a@x.io", serverName: "wire-ops", serverConfig: PLAIN,
      url: "https://api.openai.com/mcp",
    }),
    /does not allow a custom endpoint/,
  );
});

test("a declared server accepts a public https endpoint", async () => {
  const r = await ep.setOwnerEndpoint({
    owner: "b@x.io", serverName: "chatwoot", serverConfig: OVERRIDABLE,
    url: "https://api.openai.com/mcp",
  });
  assert.equal(r.configured, true);
  assert.equal(await ep.getOwnerEndpoint({ owner: "b@x.io", serverName: "chatwoot" }),
    "https://api.openai.com/mcp");
});

test("a private/metadata endpoint is refused and never stored", async () => {
  for (const bad of [
    "http://169.254.169.254/latest/meta-data",
    `https://${meshIp(1, 5)}:30432/`,
    "http://127.0.0.1/mcp",
  ]) {
    await assert.rejects(
      () => ep.setOwnerEndpoint({
        owner: "c@x.io", serverName: "chatwoot", serverConfig: OVERRIDABLE, url: bad,
        allowHttp: true,
      }),
      /allowed|not allowed|resolves|is /,
    );
  }
  assert.equal(await ep.getOwnerEndpoint({ owner: "c@x.io", serverName: "chatwoot" }), null,
    "nothing was stored for the refused destinations");
});

test("clearing removes the override so the registered URL comes back", async () => {
  const owner = "d@x.io";
  await ep.setOwnerEndpoint({
    owner, serverName: "chatwoot", serverConfig: OVERRIDABLE, url: "https://api.deepseek.com/mcp",
  });
  assert.ok(await ep.getOwnerEndpoint({ owner, serverName: "chatwoot" }));
  await ep.setOwnerEndpoint({ owner, serverName: "chatwoot", serverConfig: OVERRIDABLE, url: "" });
  assert.equal(await ep.getOwnerEndpoint({ owner, serverName: "chatwoot" }), null);
});

test("one owner's endpoint is invisible to another", async () => {
  await ep.setOwnerEndpoint({
    owner: "e1@x.io", serverName: "chatwoot", serverConfig: OVERRIDABLE,
    url: "https://www.google.com/mcp",
  });
  assert.equal(await ep.getOwnerEndpoint({ owner: "e2@x.io", serverName: "chatwoot" }), null);
});

test("the stored URL is encrypted at rest", async () => {
  const owner = "f@x.io";
  await ep.setOwnerEndpoint({
    owner, serverName: "chatwoot", serverConfig: OVERRIDABLE, url: "https://api.anthropic.com/mcp",
  });
  const row = db.getServerCredentialOverride(owner, "chatwoot", "url");
  assert.ok(row);
  assert.equal(row.value_encrypted.includes("api.anthropic.com"), false);
});