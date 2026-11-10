#!/usr/bin/env node
// ── Connector binding resolution (add-connector-bindings, 3.1-3.4) ───────────
//
// The resolver's whole job is to keep four answers apart. Pinned here:
//
//   3.1  the four states are produced from the right fact source (catalog
//        coverage for satisfied/unwired, local connections for missing, the
//        credential for stale) and `unwired` never degrades into `missing`.
//   3.2  resolving twice changes nothing — same rows, same tokens.
//   3.3  an unreachable introspection surface is `undetermined`, not `unwired`.
//   3.4  a declaration change rebuilds the binding (old token dropped), a
//        dropped key is `deprecated` and keeps its token.
//
//   node --test scripts/test-connector-binding-resolve.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-resolve-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.chdir(TMP);
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({ mcpServers: { connector: { url: "https://connector.example.test/mcp" } } })
);

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");
const bindings = await import("../connector-bindings.js");
await db.initDb();

const EMAIL = "resolver@example.com";
db.setConnectorCredential({ email: EMAIL, slot: "primary", token: "oct_account" });

/** A fake connector: coverage/connections answers are set per test. */
function fakeClient({ coverage = {}, connections = [], unreachable = false, unauthorized = false } = {}) {
  const calls = [];
  return {
    calls,
    async coverage(provider, operations) {
      calls.push(["coverage", provider, operations]);
      if (unreachable) throw new Error("ECONNREFUSED");
      if (unauthorized) return { ok: false, code: "unauthorized" };
      const answer = coverage[provider];
      if (!answer) return { ok: false, code: "not_found" };
      return {
        ok: true,
        body: {
          provider,
          operations: operations.map((operation) => ({ operation, covered: !answer.gaps?.includes(operation) })),
          gaps: answer.gaps ?? [],
        },
      };
    },
    async connections() {
      calls.push(["connections"]);
      if (unreachable) throw new Error("ECONNREFUSED");
      if (unauthorized) return { ok: false, code: "unauthorized" };
      return { ok: true, body: { connections } };
    },
  };
}

const declaration = (over = {}) => ({
  key: "kingdee-cloud",
  provider: "kingdee",
  allowOperations: [{ operationType: "read" }, { operationType: "write" }],
  optional: false,
  connectionHint: "账套A",
  ...over,
});

async function resolveOne({ client, binding = declaration(), packId = "pack-a", email = EMAIL }) {
  return bindings.resolvePack({ email, packId, packVersion: "1.0.0", bindings: [binding], client });
}

test("satisfied: catalog covers the classes and the user holds a connection", async () => {
  const client = fakeClient({
    coverage: { kingdee: {} },
    connections: [
      { id: "conn-b", service: "kingdee", connectionName: "账套B", configured: true },
      { id: "conn-a", service: "kingdee", connectionName: "账套A", configured: true },
    ],
  });
  const [row] = await resolveOne({ client, packId: "pack-satisfied" });
  assert.equal(row.status, "satisfied");
  // The declared connection hint wins over the first match, and the ledger
  // records the connector's id — not the name, which can be renamed.
  assert.equal(row.connectionId, "conn-a");
  assert.equal(row.connectionName, "账套A");
  assert.deepEqual(row.operations, ["read", "write"]);
});

test("missing: catalog is fine but the user holds no connection for that provider", async () => {
  const client = fakeClient({
    coverage: { kingdee: {} },
    connections: [{ service: "feishu", connectionName: "default", configured: true }],
  });
  const [row] = await resolveOne({ client, packId: "pack-missing" });
  assert.equal(row.status, "missing");
  assert.equal(row.reason, "no_connection");
});

test("unwired: a known provider without the declared class is a capability gap, never missing", async () => {
  const client = fakeClient({
    coverage: { kingdee: { gaps: ["write"] } },
    connections: [{ service: "kingdee", connectionName: "default", configured: true }],
  });
  const [row] = await resolveOne({ client, packId: "pack-unwired" });
  assert.equal(row.status, "unwired");
  assert.match(row.reason, /catalog_gap:write/);
});

test("unwired: an unknown provider is a capability gap too", async () => {
  const client = fakeClient({ coverage: {}, connections: [{ service: "kingdee", connectionName: "default" }] });
  const [row] = await resolveOne({
    client,
    packId: "pack-unknown-provider",
    binding: declaration({ key: "wms", provider: "wms", allowOperations: ["read"] }),
  });
  assert.equal(row.status, "unwired");
  assert.match(row.reason, /unknown_provider:wms/);
});

test("an alternative provider resolves the binding when the first one is unwired", async () => {
  const client = fakeClient({
    coverage: { alipay: {} },
    connections: [{ id: "conn-pay", service: "alipay", connectionName: "merchant" }],
  });
  const [row] = await resolveOne({
    client,
    packId: "pack-alternative",
    binding: declaration({
      key: "payments",
      provider: "wechatpay",
      alternativeProviders: ["alipay"],
      allowOperations: ["read"],
      connectionHint: "",
    }),
  });
  assert.equal(row.status, "satisfied");
  assert.equal(row.provider, "alipay");
  assert.equal(row.connectionId, "conn-pay");
  assert.equal(row.connectionName, "merchant");
});

test("stale: a revoked binding token is stale without asking the catalog", async () => {
  const packId = "pack-stale";
  db.setConnectorBinding({ email: EMAIL, slot: bindings.bindingSlot(packId, "kingdee-cloud"), token: "oct_dead" });
  db.markConnectorBindingStale(EMAIL, bindings.bindingSlot(packId, "kingdee-cloud"));
  const client = fakeClient({ coverage: { kingdee: {} }, connections: [{ service: "kingdee", connectionName: "a" }] });

  const [row] = await resolveOne({ client, packId });
  assert.equal(row.status, "stale");
  assert.equal(client.calls.length, 0, "no introspection with a token we know is dead");
});

test("stale: a 401 from the connector is a credential failure, not a capability gap", async () => {
  const [row] = await resolveOne({ client: fakeClient({ unauthorized: true }), packId: "pack-401" });
  assert.equal(row.status, "stale");
  assert.equal(row.reason, "credential_rejected");
});

test("undetermined: an unreachable connector is never reported as unwired (3.3)", async () => {
  const [row] = await resolveOne({ client: fakeClient({ unreachable: true }), packId: "pack-down" });
  assert.equal(row.status, "undetermined");
  assert.equal(row.reason, "catalog_unreachable");
});

test("undetermined: no connector configured in this deployment", async () => {
  const [row] = await resolveOne({ client: null, packId: "pack-no-connector" });
  assert.equal(row.status, "undetermined");
  assert.equal(row.reason, "connector_not_configured");
});

test("resolution is idempotent — rows and tokens survive a second pass (3.2)", async () => {
  const packId = "pack-idempotent";
  const client = fakeClient({
    coverage: { kingdee: {} },
    connections: [{ service: "kingdee", connectionName: "default" }],
  });
  const slot = bindings.bindingSlot(packId, "kingdee-cloud");
  db.setConnectorBinding({ email: EMAIL, slot, token: "oct_grant" });

  const first = await resolveOne({ client, packId });
  const snapshot = JSON.stringify(bindings.listBindings(EMAIL, packId));
  const second = await resolveOne({ client, packId });

  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(bindings.listBindings(EMAIL, packId)), snapshot);
  assert.equal(bindings.liveBindingToken(EMAIL, packId, "kingdee-cloud"), "oct_grant");
  assert.equal(db.getConnectorBinding(EMAIL, slot).token, "oct_grant");
});

test("a declaration change drops the old token and asks for a fresh grant (3.4)", async () => {
  const packId = "pack-upgrade";
  const slot = bindings.bindingSlot(packId, "kingdee-cloud");
  const client = fakeClient({
    coverage: { kingdee: {} },
    connections: [{ service: "kingdee", connectionName: "default" }],
  });

  // v1 asks for read only, and the user granted it.
  await bindings.resolvePack({
    email: EMAIL,
    packId,
    packVersion: "1.0.0",
    bindings: [declaration({ allowOperations: ["read"] })],
    client,
  });
  db.setConnectorBinding({ email: EMAIL, slot, token: "oct_v1", purpose: "pack:pack-upgrade/kingdee-cloud" });
  assert.equal(bindings.liveBindingToken(EMAIL, packId, "kingdee-cloud"), "oct_v1");

  // Same key, wider declared range: the old token no longer describes it.
  const [row] = await bindings.resolvePack({
    email: EMAIL,
    packId,
    packVersion: "2.0.0",
    bindings: [declaration({ allowOperations: [{ operationType: "read" }, { operationType: "write" }] })],
    client,
  });
  assert.equal(row.status, "satisfied");
  assert.equal(bindings.liveBindingToken(EMAIL, packId, "kingdee-cloud"), null, "old token must be dropped");
  // A grant time behind no token would be a lie to the status face.
  assert.equal(row.grantedAt, null);
  assert.deepEqual(row.operations, ["read", "write"]);
  assert.equal(bindings.listBindings(EMAIL, packId)[0].packVersion, "2.0.0");
  assert.deepEqual(bindings.injectableBindings(EMAIL, packId), [], "nothing injectable until re-granted");
});

test("a binding key the pack drops is deprecated and keeps its token (3.4)", async () => {
  const packId = "pack-dropped";
  const slot = bindings.bindingSlot(packId, "legacy-binding");
  const client = fakeClient({ coverage: { kingdee: {} }, connections: [{ service: "kingdee", connectionName: "a" }] });

  await bindings.resolvePack({
    email: EMAIL,
    packId,
    packVersion: "1.0.0",
    bindings: [declaration({ key: "legacy-binding" })],
    client,
  });
  db.setConnectorBinding({ email: EMAIL, slot, token: "oct_legacy", purpose: `pack:${packId}/legacy-binding` });

  await bindings.resolvePack({
    email: EMAIL,
    packId,
    packVersion: "1.1.0",
    bindings: [declaration({ key: "kingdee-cloud" })],
    client,
  });

  const rows = bindings.listBindings(EMAIL, packId);
  const dropped = rows.find((row) => row.bindingKey === "legacy-binding");
  assert.equal(dropped.status, "deprecated");
  // Not revoked: a running session must not lose a capability on upgrade.
  assert.equal(db.getConnectorBinding(EMAIL, slot).token, "oct_legacy");
  // And it is not injectable: deprecation means "do not advertise".
  assert.equal(
    bindings.injectableBindings(EMAIL, packId).some((row) => row.bindingKey === "legacy-binding"),
    false
  );
});

test("injectableBindings only returns satisfied rows that carry a token (3.1)", async () => {
  const packId = "pack-injectable";
  const client = fakeClient({
    coverage: { kingdee: {} },
    connections: [{ service: "kingdee", connectionName: "default" }],
  });
  await resolveOne({ client, packId });

  // Satisfied but not granted yet: nothing to inject.
  assert.deepEqual(bindings.injectableBindings(EMAIL, packId), []);

  db.setConnectorBinding({
    email: EMAIL,
    slot: bindings.bindingSlot(packId, "kingdee-cloud"),
    token: "oct_granted",
    purpose: `pack:${packId}/kingdee-cloud`,
  });
  const injectable = bindings.injectableBindings(EMAIL, packId);
  assert.deepEqual(injectable.map((row) => row.bindingKey), ["kingdee-cloud"]);
  assert.equal(bindings.liveBindingToken(EMAIL, packId, "kingdee-cloud"), "oct_granted");
});

test("the real client turns a transport failure into a code, not a throw (3.3)", async () => {
  const refused = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_x",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.deepEqual(await refused.coverage("kingdee", ["read"]), { ok: false, code: "unavailable" });
  assert.deepEqual(await refused.connections(), { ok: false, code: "unavailable" });

  // And the resolver composes that into `undetermined` end to end.
  const [row] = await bindings.resolvePack({
    email: EMAIL,
    packId: "pack-real-client-down",
    packVersion: "1.0.0",
    bindings: [declaration()],
    client: refused,
  });
  assert.equal(row.status, "undetermined");

  const statuses = (status) =>
    bindings.createConnectorClient({
      origin: "https://connector.example.test",
      token: "oct_x",
      fetchImpl: async () => ({ status, ok: status < 400, json: async () => ({}) }),
    });
  assert.deepEqual(await statuses(401).coverage("kingdee", ["read"]), { ok: false, code: "unauthorized" });
  assert.deepEqual(await statuses(404).coverage("kingdee", ["read"]), { ok: false, code: "not_found" });
  assert.deepEqual(await statuses(503).coverage("kingdee", ["read"]), { ok: false, code: "unavailable" });
  // A 2xx with an unparseable body is still "we could not read the answer".
  const garbage = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_x",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }),
  });
  assert.deepEqual(await garbage.connections(), { ok: false, code: "unavailable" });
});

test("a real 2xx coverage answer drives satisfied, and the token travels as a bearer (3.1)", async () => {
  const seen = [];
  const client = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_bearer",
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers.Authorization]);
      const body = url.includes("catalog-coverage")
        ? { provider: "kingdee", operations: [], gaps: [] }
        : { connections: [{ id: "conn-a", service: "kingdee", connectionName: "账套A" }] };
      return { status: 200, ok: true, json: async () => body };
    },
  });
  const [row] = await bindings.resolvePack({
    email: EMAIL,
    packId: "pack-real-client-ok",
    packVersion: "1.0.0",
    bindings: [declaration()],
    client,
  });
  assert.equal(row.status, "satisfied");
  assert.equal(row.connectionName, "账套A");
  assert.ok(seen.every(([, auth]) => auth === "Bearer oct_bearer"));
  assert.match(seen[0][0], /^https:\/\/connector\.example\.test\/api\/tenant\/catalog-coverage\?provider=kingdee&operations=read(%2C|,)write$/);
});

test("a virtual connection satisfies the binding — nothing for the user to configure", async () => {
  // The connector lists no_auth and operator-enabled marketplace providers as
  // `virtual: true, configured: true` even when the user stored nothing. Those
  // need no user action, so the binding is satisfied; the flag rides along so
  // the status face can say "平台代管" instead of naming a connection the user
  // never made.
  const client = fakeClient({
    coverage: { feishu: {} },
    connections: [
      { id: "feishu:default", service: "feishu", connectionName: "default", configured: true, virtual: true },
    ],
  });
  const [row] = await resolveOne({
    client,
    packId: "pack-virtual",
    binding: declaration({ key: "feishu", provider: "feishu", allowOperations: ["read"], connectionHint: "" }),
  });
  assert.equal(row.status, "satisfied");
  assert.equal(row.connectionId, "feishu:default");
  assert.equal(row.connectionVirtual, true);
});

test("a connection reported as not configured does not count as held", async () => {
  const client = fakeClient({
    coverage: { kingdee: {} },
    connections: [{ id: "conn-a", service: "kingdee", connectionName: "账套A", configured: false }],
  });
  const [row] = await resolveOne({ client, packId: "pack-unconfigured" });
  assert.equal(row.status, "missing");
});

test("revoking a grant falls back to missing and drops the token (3.4 / 5.5)", async () => {
  const packId = "pack-revoke";
  const slot = bindings.bindingSlot(packId, "kingdee-cloud");
  const client = fakeClient({
    coverage: { kingdee: {} },
    connections: [{ service: "kingdee", connectionName: "default" }],
  });
  await resolveOne({ client, packId });
  db.setConnectorBinding({ email: EMAIL, slot, token: "oct_to_revoke" });

  assert.equal(bindings.revokeBindingGrant(EMAIL, packId, "kingdee-cloud"), true);
  assert.equal(db.getConnectorBinding(EMAIL, slot), null);
  assert.equal(bindings.listBindings(EMAIL, packId)[0].status, "missing");
});
