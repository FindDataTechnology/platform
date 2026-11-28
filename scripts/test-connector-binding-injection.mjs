#!/usr/bin/env node
// ── Connector binding injection (add-connector-bindings, 4.1-4.3) ────────────
//
// The profile is where "declared" becomes "usable", so this file pins the shape
// of that step and nothing else:
//
//   4.1  credential-refs resolves PER ROW (a binding row carries its own token)
//        while every single-token ref keeps resolving exactly as before.
//   4.2  the baseline `connector` row is a template: it supplies url/transport
//        and is never injected itself. Rows are `connector:<slot>`, one per
//        authorized binding, each with its own Authorization. No binding ⇒ no
//        connector row at all.
//   4.3  one binding going bad removes exactly that row; the others keep
//        injecting, and the invalidation reports "changed" exactly once so the
//        caller re-applies the profile exactly once.
//
//   node --test scripts/test-connector-binding-injection.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-inject-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "service-token";
delete process.env.REGISTRY_URL;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({
    mcpServers: {
      "file-server": { url: "https://file.example/mcp" },
      // The template: transport + the retired single-token ref.
      connector: { url: "https://connector.example.test/mcp", credentialRef: "connector" },
    },
  }),
);
process.chdir(TMP);
fs.writeFileSync(path.join(TMP, "market-catalog.json"), JSON.stringify({ mcpServers: [] }));
fs.writeFileSync(path.join(TMP, "market-catalog-skills.json"), JSON.stringify({ skills: [] }));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");
const bindings = await import("../connector-bindings.js");
const names = bindings;
const credentialRefs = await import("../credential-refs.js");
const { writeMcpPatch } = await import("../dsh-profile.js");

const bridge = await import("../registry-bridge.js");
bridge.initRegistryBridge({
  broadcast: () => {},
  fetchImpl: async (url) =>
    url.includes("/api/skills")
      ? { ok: true, status: 200, json: async () => ({ skills: [] }) }
      : url.includes("/api/agents")
        ? { ok: true, status: 200, json: async () => ({ agents: [] }) }
        : { ok: true, status: 200, json: async () => ({ servers: [] }) },
});
await bridge.refreshRegistry();
await db.initDb();

const PATCH_FILE = path.join(
  process.env.DSH_HOME,
  "profiles",
  process.env.DSH_PROFILE || "platform",
  "mcp.patch.yml",
);
async function writePatch(opts) {
  fs.rmSync(PATCH_FILE, { force: true });
  await writeMcpPatch(opts);
}
function patchEntries() {
  if (!fs.existsSync(PATCH_FILE)) return [];
  const rows = yaml.load(fs.readFileSync(PATCH_FILE, "utf8"));
  return Array.isArray(rows) ? (rows[0]?.insert ?? []) : [];
}
const patchEntry = (name) => patchEntries().find((entry) => entry.config.serverName === name);
const patchNames = () => patchEntries().map((entry) => entry.config.serverName);

/** Install a pack and give `email` two settled bindings on it, both granted. */
function seedPackBindings(email, { packId = "pack-supply", tokens = ["oct_k1", "oct_k2"] } = {}) {
  db.upsertInstalledPack({ packId, name: packId, version: "1.0.0", manifest: {}, report: {}, source: "market" });
  const decls = [
    { key: "kingdee-cloud", provider: "kingdee", allowOperations: ["read", "write"] },
    { key: "payments", provider: "alipay", allowOperations: ["read"] },
  ];
  decls.forEach((decl, index) => {
    db.upsertConnectorBindingLedgerRow({
      email,
      packId,
      packVersion: "1.0.0",
      bindingKey: decl.key,
      provider: decl.provider,
      operations: decl.allowOperations,
      connectionId: `conn-${index}`,
      status: "satisfied",
    });
    db.setConnectorBinding({
      email,
      slot: bindings.bindingSlot(packId, decl.key),
      token: tokens[index],
      purpose: `pack:${packId}/${decl.key}`,
    });
  });
  return { packId, decls };
}

test("4.2 two bindings inject as two rows, each with its own Authorization", async () => {
  const email = "inject-two@x.test";
  const { packId } = seedPackBindings(email);

  await writePatch({ ownerEmail: email });

  const first = patchEntry(names.bindingServerName(`${packId}:kingdee-cloud`));
  const second = patchEntry(names.bindingServerName(`${packId}:payments`));
  assert.ok(first, "first binding row injected");
  assert.ok(second, "second binding row injected");
  assert.equal(first.config.headers.Authorization, "Bearer oct_k1");
  assert.equal(second.config.headers.Authorization, "Bearer oct_k2");
  assert.notEqual(first.config.headers.Authorization, second.config.headers.Authorization);

  // Both point at the template's transport. The ref itself stays on the server
  // side: the cell patch carries the resolved header only, never the ref name or
  // the slot (nothing in the cell needs them, and a leaked slot is a handle).
  assert.equal(first.config.url, "https://connector.example.test/mcp");
  assert.equal(first.config.credentialRef, undefined);
  assert.equal(second.config.credentialRef, undefined);
  assert.equal(first.config.slot, undefined);

  // The template itself is gone from the profile, and unrelated rows survive.
  assert.equal(patchNames().includes("connector"), false, "the global row is retired");
  assert.equal(patchNames().includes("file-server"), true);
});

test("4.2 no authorized binding ⇒ no connector row at all", async () => {
  const email = "inject-none@x.test";
  await writePatch({ ownerEmail: email });
  assert.equal(
    patchNames().some((name) => name.startsWith("connector")),
    false,
    "a user with no binding gets no connector row",
  );
  assert.equal(patchNames().includes("file-server"), true, "other rows unaffected");
});

test("4.2 a full-authority account token is only injected through its binding", async () => {
  // The account exists, so the pre-change model would have injected the global
  // row with it. Only the built-in binding may carry it, and only as a row.
  const email = "inject-account@x.test";
  const connectorCredentials = await import("../connector-credentials.js");
  connectorCredentials.store({ email, token: "oct_full_authority" });

  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes("connector"), false);
  assert.equal(patchEntry(names.bindingServerName("chat:explore")).config.headers.Authorization, "Bearer oct_full_authority");

  // Drop the binding: the token still exists, but nothing may inject it.
  db.deleteConnectorBinding(email, db.CONNECTOR_EXPLORE_BINDING);
  await writePatch({ ownerEmail: email });
  assert.equal(
    patchNames().some((name) => name.startsWith("connector")),
    false,
    "no injectable binding ⇒ no connector row, even with a live account token",
  );
  connectorCredentials.disconnect(email);
});

test("4.2 an installed-pack filter keeps an uninstalled pack's binding out", async () => {
  const email = "inject-uninstalled@x.test";
  const { packId } = seedPackBindings(email, { packId: "pack-gone", tokens: ["oct_x", "oct_y"] });
  // Uninstall the pack: the ledger rows and tokens survive (nothing is revoked
  // by an upgrade/downgrade), but the capability must not be injected.
  db.getDb().prepare("DELETE FROM installed_packs WHERE pack_id = ?").run(packId);

  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes(names.bindingServerName(`${packId}:kingdee-cloud`)), false);
  assert.equal(db.getConnectorBinding(email, bindings.bindingSlot(packId, "kingdee-cloud")).token, "oct_x");
});

test("4.3 one binding going stale removes exactly that row (and only it)", async () => {
  const email = "inject-degrade@x.test";
  const { packId } = seedPackBindings(email, { packId: "pack-degrade" });

  await writePatch({ ownerEmail: email });
  assert.ok(patchEntry(names.bindingServerName(`${packId}:kingdee-cloud`)));
  assert.ok(patchEntry(names.bindingServerName(`${packId}:payments`)));

  // The 401 handler marks the slot; the next write drops only that row.
  assert.equal(
    credentialRefs.invalidateRef(bindings.CONNECTOR_BINDING_CREDENTIAL_REF, email, {
      slot: bindings.bindingSlot(packId, "kingdee-cloud"),
    }),
    true,
    "first invalidation reports a state change (⇒ re-apply)",
  );
  // Second 401 on the same row: no state change, so no second re-apply.
  assert.equal(
    credentialRefs.invalidateRef(bindings.CONNECTOR_BINDING_CREDENTIAL_REF, email, {
      slot: bindings.bindingSlot(packId, "kingdee-cloud"),
    }),
    false,
  );

  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes(names.bindingServerName(`${packId}:kingdee-cloud`)), false, "failed row omitted");
  assert.equal(
    patchEntry(names.bindingServerName(`${packId}:payments`)).config.headers.Authorization,
    "Bearer oct_k2",
    "other row keeps its own token",
  );
  // The ledger agrees, so the status face and the profile say the same thing.
  const ledger = bindings.listBindings(email, packId);
  assert.equal(ledger.find((row) => row.bindingKey === "kingdee-cloud").status, "stale");
  assert.equal(ledger.find((row) => row.bindingKey === "payments").status, "satisfied");
});

test("4.3 a revoked binding disappears; re-granting brings it back with the new token", async () => {
  const email = "inject-revoke@x.test";
  const { packId } = seedPackBindings(email, { packId: "pack-revoke2" });
  await writePatch({ ownerEmail: email });

  assert.equal(bindings.revokeBindingGrant(email, packId, "payments"), true);
  await writePatch({ ownerEmail: email });
  assert.equal(patchNames().includes(names.bindingServerName(`${packId}:payments`)), false);
  assert.equal(patchNames().includes(names.bindingServerName(`${packId}:kingdee-cloud`)), true);

  // Re-grant is a fresh token on the same slot; resolution must mark it
  // satisfied again for the row to come back.
  db.upsertConnectorBindingLedgerRow({
    email,
    packId,
    packVersion: "1.0.0",
    bindingKey: "payments",
    provider: "alipay",
    operations: ["read"],
    connectionId: "conn-1",
    status: "satisfied",
  });
  db.setConnectorBinding({ email, slot: bindings.bindingSlot(packId, "payments"), token: "oct_k2_fresh" });
  await writePatch({ ownerEmail: email });
  assert.equal(patchEntry(names.bindingServerName(`${packId}:payments`)).config.headers.Authorization, "Bearer oct_k2_fresh");
});

test("4.1 single-token refs resolve byte-identically through the new per-row pass", async () => {
  const email = "inject-registry@x.test";
  const registryCredentials = await import("../registry-credentials.js");
  const jwt = (() => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u", exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
  })();
  registryCredentials.store({ email, token: jwt });

  const servers = {
    "reg-one": { url: "https://registry.example.test/a/mcp", credentialRef: "registry" },
    "reg-two": { url: "https://registry.example.test/b/mcp", credentialRef: "registry" },
    plain: { url: "https://plain.example/mcp" },
  };
  const resolved = credentialRefs.resolveCredentials(servers, email);
  assert.equal(resolved.servers["reg-one"].headers.Authorization, `Bearer ${jwt}`);
  assert.equal(resolved.servers["reg-two"].headers.Authorization, `Bearer ${jwt}`);
  assert.equal(resolved.servers.plain.headers, undefined, "non-ref rows untouched");
  // Reported as one ref group, as before.
  assert.deepEqual(resolved.injected, [{ ref: "registry", names: ["reg-one", "reg-two"] }]);
  assert.deepEqual(resolved.omitted, []);

  // No credential ⇒ every row of that ref omitted, still one group.
  const anon = credentialRefs.resolveCredentials(servers, "nobody@x.test");
  assert.deepEqual(anon.omitted, [{ ref: "registry", names: ["reg-one", "reg-two"] }]);
  assert.equal(anon.servers["reg-one"], undefined);
  assert.ok(anon.servers.plain);
  registryCredentials.disconnect(email);
});

test("4.1 a ref that resolves per row reports injected and omitted separately", () => {
  const email = "inject-mixed@x.test";
  db.setConnectorBinding({ email, slot: "chat:explore", token: "oct_live" });
  const servers = {
    "connector:chat:explore": { url: "u", credentialRef: "connector-binding", slot: "chat:explore" },
    "connector:pack:dead": { url: "u", credentialRef: "connector-binding", slot: "pack:dead" },
  };
  const resolved = credentialRefs.resolveCredentials(servers, email);
  assert.equal(resolved.servers["connector:chat:explore"].headers.Authorization, "Bearer oct_live");
  assert.equal(resolved.servers["connector:pack:dead"], undefined);
  assert.deepEqual(resolved.injected, [{ ref: "connector-binding", names: ["connector:chat:explore"] }]);
  assert.deepEqual(resolved.omitted, [{ ref: "connector-binding", names: ["connector:pack:dead"] }]);
});

test("4.1 the slot-only contract: a binding row resolves by slot, not by a global token", () => {
  const email = "inject-slot@x.test";
  db.setConnectorBinding({ email, slot: "pack-a:one", token: "oct_one" });
  db.setConnectorBinding({ email, slot: "pack-b:one", token: "oct_two" });
  // Same binding key in two packs, different tokens: the slot decides.
  assert.equal(credentialRefs.liveTokenForRef("connector-binding", email, { slot: "pack-a:one" }), "oct_one");
  assert.equal(credentialRefs.liveTokenForRef("connector-binding", email, { slot: "pack-b:one" }), "oct_two");
  // Without a slot there is nothing to resolve — never a fallback to "some" row.
  assert.equal(credentialRefs.liveTokenForRef("connector-binding", email), null);
  assert.equal(credentialRefs.liveTokenForRef("connector-binding", email, {}), null);
});
