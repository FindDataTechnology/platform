#!/usr/bin/env node
// ── Connector binding grants (add-connector-bindings, 5.1-5.5) ───────────────
//
// The grant flow is where authority is handed out, so the tests are about
// restraint as much as success:
//
//   5.1  the install gate separates "connected" from "needs a connection" and
//        refuses to call a pack connected while a required binding is open;
//        an optional binding only degrades itself.
//   5.2  declarative grant: one confirmation grants every resolvable binding;
//        without it no token exists.
//   5.3  progressive grant: a rejected action widens exactly the binding that
//        owns it, and the rejected call is NOT replayed.
//   5.4  one grant per (provider, operationType): a second rejection of a class
//        already in scope produces no card and no mint.
//   5.5  revoke removes the token locally and asks the connector to revoke the
//        PAT; a 401 flips that binding to stale and leaves siblings alone.
//
// The connector is a small in-process fake — the real one lives in
// open-connector-mt and is exercised by its own suite; here we need its
// contract (pats / scope-explain / catalog-coverage / connections), not it.
//
//   node --test scripts/test-connector-binding-grants.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-grants-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.chdir(TMP);
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({ mcpServers: { connector: { url: "https://connector.example.test/mcp", credentialRef: "connector" } } }),
);

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");
const bindings = await import("../connector-bindings.js");
const grants = await import("../connector-grants.js");
const connectorCredentials = await import("../connector-credentials.js");
await db.initDb();

const EMAIL = "grants@example.com";
connectorCredentials.store({ email: EMAIL, token: "oct_account_parent" });

// ── The fake connector ───────────────────────────────────────────────────────
// Coverage/connections answer the resolution; pats mints with the same-name
// union behaviour the real one has; scope-explain reports what an action needs.
function fakeConnector({ coverage = {}, connections = [], actions = {} } = {}) {
  const log = [];
  const pats = new Map(); // id -> {name, allowedOperations}
  let seq = 0;
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    log.push({ method, pathname, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

    if (pathname === "/api/tenant/pats" && method === "POST") {
      const body = JSON.parse(init.body);
      // Same-name re-mint unions and the old token goes (non-cascading revoke).
      let union = body.allowedOperations ?? [];
      let unionActions = body.allowedActions ?? [];
      for (const [id, pat] of [...pats]) {
        if (pat.name !== body.name) continue;
        union = dedupeOperations([...union, ...pat.allowedOperations]);
        unionActions = [...new Set([...unionActions, ...(pat.allowedActions ?? [])])];
        pats.delete(id);
      }
      seq += 1;
      const id = `pat-${seq}`;
      pats.set(id, { name: body.name, allowedOperations: union, allowedActions: unionActions, purpose: body.purpose });
      return json(200, { token: `oct_minted_${seq}`, id, name: body.name });
    }
    if (pathname.startsWith("/api/tenant/pats/") && method === "DELETE") {
      const id = decodeURIComponent(pathname.slice("/api/tenant/pats/".length));
      pats.delete(id);
      return json(204, null);
    }
    if (pathname === "/api/tenant/scope-explain") {
      const actionId = searchParams.get("actionId");
      const action = actions[actionId];
      if (!action) return json(404, { error: { code: "unknown_action", message: `Unknown action: ${actionId}` } });
      return json(200, {
        actionId,
        provider: action.provider,
        operationType: action.operationType,
        allowed: !!action.allowed,
        code: action.allowed ? null : "action_not_allowed",
        checks: [],
      });
    }
    if (pathname === "/api/tenant/catalog-coverage") {
      const provider = searchParams.get("provider");
      const answer = coverage[provider];
      if (!answer) return json(404, { error: { code: "unknown_provider", message: `Unknown provider: ${provider}` } });
      const wanted = (searchParams.get("operations") ?? "").split(",").filter(Boolean);
      const gaps = (answer.gaps ?? []).filter((gap) => wanted.includes(gap));
      return json(200, { provider, operations: wanted.map((operation) => ({ operation, covered: !gaps.includes(operation) })), gaps });
    }
    if (pathname === "/api/tenant/connections") return json(200, { connections });
    return json(404, { error: { code: "not_found", message: "Not found." } });
  };
  return { fetchImpl, log, pats };
}

function dedupeOperations(operations) {
  const seen = new Set();
  return operations.filter((operation) => {
    const key = `${operation.provider}@${operation.operationType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Install a pack with the given connector_bindings declarations. */
function installPackWith(packId, connectorBindings, { email = EMAIL, version = "1.0.0" } = {}) {
  db.upsertInstalledPack({
    packId,
    name: packId,
    version,
    manifest: { name: packId, connector_bindings: connectorBindings },
    report: {},
    source: "market",
  });
  // Ledger rows are what a resolution writes; seed them as that resolution
  // would (tests below assert against the real resolver too).
  for (const declaration of connectorBindings) {
    db.upsertConnectorBindingLedgerRow({
      email,
      packId,
      packVersion: version,
      bindingKey: declaration.key,
      provider: declaration.provider,
      operations: bindings.declaredOperations(declaration),
      connectionId: null,
      status: declaration.status ?? "satisfied",
      optional: !!declaration.optional,
    });
  }
}

const decl = (over = {}) => ({
  key: "kingdee-cloud",
  provider: "kingdee",
  allowOperations: ["read", "write"],
  optional: false,
  ...over,
});

// ── 5.1 Install gate ────────────────────────────────────────────────────────

test("5.1 gate: every required binding resolvable and granted ⇒ connected", async () => {
  const packId = "pack-ready";
  installPackWith(packId, [decl()]);
  const client = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_account_parent",
    fetchImpl: fakeConnector({
      coverage: { kingdee: {} },
      connections: [{ id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true }],
    }).fetchImpl,
  });
  const { gate, bindings: rows } = await grants.refreshPackBindings({ email: EMAIL, packId, client });

  assert.equal(rows[0].status, "satisfied");
  // Satisfied but not granted yet: the pack is not "connected" until the user
  // confirms the dialog — that is the point of the pendingGrant list.
  assert.equal(gate.connected, false);
  assert.deepEqual(gate.pendingGrant.map((row) => row.bindingKey), ["kingdee-cloud"]);
  assert.deepEqual(gate.unresolved, []);

  const granted = await grants.grantPack({ email: EMAIL, packId, fetchImpl: fakeConnector().fetchImpl });
  assert.deepEqual(granted.granted.map((row) => row.bindingKey), ["kingdee-cloud"]);
  const after = await grants.refreshPackBindings({ email: EMAIL, packId, client });
  assert.equal(after.gate.connected, true, "granted + satisfied ⇒ connected");
  assert.deepEqual(after.gate.pendingGrant, []);
});

test("5.1 gate: a required binding with no connection keeps the pack unconnected", async () => {
  const packId = "pack-needs-connection";
  installPackWith(packId, [decl({ key: "kingdee-cloud" }), decl({ key: "payments", provider: "alipay", allowOperations: ["read"] })]);
  const client = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_account_parent",
    fetchImpl: fakeConnector({
      coverage: { kingdee: {}, alipay: {} },
      connections: [{ id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true }],
    }).fetchImpl,
  });
  const { gate } = await grants.refreshPackBindings({ email: EMAIL, packId, client });
  assert.equal(gate.connected, false);
  assert.deepEqual(
    gate.unresolved.map((row) => [row.bindingKey, row.status, row.reason]),
    [["payments", "missing", "no_connection"]],
  );
  // The resolvable one is still offered for granting — a missing sibling must
  // not block what can be connected today.
  assert.deepEqual(gate.grantable.map((row) => row.bindingKey), ["kingdee-cloud"]);
});

test("5.1 gate: an unmet optional binding degrades itself only", async () => {
  const packId = "pack-optional";
  // The optional binding must be *declared* — a ledger row the manifest no
  // longer mentions is `deprecated` (the pack dropped it), and that is a
  // different state from "declared but unimplemented".
  installPackWith(packId, [decl({ key: "kingdee-cloud" }), decl({ key: "wms", provider: "wms", allowOperations: ["read"], optional: true })]);
  const client = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_account_parent",
    fetchImpl: fakeConnector({
      coverage: { kingdee: {}, wms: {} },
      connections: [{ id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true }],
    }).fetchImpl,
  });
  const { gate } = await grants.refreshPackBindings({ email: EMAIL, packId, client });
  assert.deepEqual(gate.unresolved, [], "optional misses are not blockers");
  assert.deepEqual(gate.optionalUnmet.map((row) => row.bindingKey), ["wms"]);
  assert.equal(gate.optionalUnmet[0].status, "missing", "declared but unconnected, not deprecated");
  assert.equal(gate.required, 1, "only the required binding counts");
});

test("5.1 gate: an unwired provider is reported as a capability gap, not as a user error", async () => {
  const packId = "pack-unwired";
  installPackWith(packId, [decl({ key: "wms", provider: "wms", allowOperations: ["read"] })]);
  const client = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_account_parent",
    fetchImpl: fakeConnector({ coverage: {}, connections: [] }).fetchImpl,
  });
  const { gate } = await grants.refreshPackBindings({ email: EMAIL, packId, client });
  assert.equal(gate.connected, false);
  assert.equal(gate.unresolved[0].status, "unwired");
  assert.match(gate.unresolved[0].reason, /unknown_provider/);
  assert.deepEqual(gate.grantable, [], "nothing to mint for a provider the catalog lacks");
});

test("5.1 installPack records the gate in its report instead of claiming success", async () => {
  const packStore = await import("../pack-store.js");
  const manifest = {
    name: "gate-pack",
    skills: [{ name: "gate-skill", description: "d", content: "c" }],
    mcpServers: [],
    agents: [],
    connector_bindings: [decl({ key: "wms", provider: "wms", allowOperations: ["read"] })],
  };
  const { report } = await packStore.installPack({
    packId: "gate-pack",
    version: 1,
    manifest,
    user: { email: EMAIL },
  });
  assert.ok(report.connector, "the report carries the binding gate");
  assert.equal(report.connector.connected, false, "an unresolved required binding is not connected");
  assert.deepEqual(report.connector.unresolved.map((row) => row.bindingKey), ["wms"]);
  // No token, no PAT id, no connection id anywhere in the report.
  const serialized = JSON.stringify(report.connector);
  assert.ok(!serialized.includes("oct_"), "no token in the install report");
  assert.ok(!serialized.includes("pat-"), "no PAT id in the install report");
});

// ── 5.2 Declarative grant ───────────────────────────────────────────────────

test("5.2 one dialog grants every resolvable binding; nothing before that", async () => {
  const email = "declarative@example.com";
  connectorCredentials.store({ email, token: "oct_parent_decl" });
  const packId = "pack-declarative";
  db.upsertInstalledPack({ packId, name: packId, version: 1, manifest: { name: packId }, report: {}, source: "market" });
  for (const [key, provider, operations] of [
    ["kingdee-cloud", "kingdee", ["read", "write"]],
    ["payments", "alipay", ["read"]],
  ]) {
    db.upsertConnectorBindingLedgerRow({
      email, packId, packVersion: "1", bindingKey: key, provider, operations,
      connectionId: `conn-${key}`, status: "satisfied",
    });
  }
  // Before any confirmation: no binding token exists, so nothing injects.
  assert.deepEqual(bindings.injectableBindings(email, packId), []);

  const connector = fakeConnector();
  const result = await grants.grantPack({ email, packId, fetchImpl: connector.fetchImpl });
  assert.deepEqual(result.granted.map((row) => row.bindingKey).sort(), ["kingdee-cloud", "payments"]);
  assert.deepEqual(result.failed, []);

  // One mint per binding, each asking for exactly the declared classes.
  const mints = connector.log.filter((entry) => entry.method === "POST" && entry.pathname === "/api/tenant/pats");
  assert.equal(mints.length, 2);
  assert.deepEqual(mints[0].body.allowedOperations, [
    { provider: "kingdee", operationType: "read" },
    { provider: "kingdee", operationType: "write" },
  ]);
  assert.deepEqual(mints[1].body.allowedOperations, [{ provider: "alipay", operationType: "read" }]);

  // Each binding now injects with its own token.
  const injectable = bindings.injectableBindings(email, packId);
  assert.equal(injectable.length, 2);
  const tokens = injectable.map((row) => bindings.liveBindingToken(email, packId, row.bindingKey));
  assert.equal(new Set(tokens).size, 2, "one distinct token per binding");
});

test("5.2 an action-scoped declaration is grantable: the rules travel with the mint", async () => {
  const email = "actions-only@example.com";
  connectorCredentials.store({ email, token: "oct_parent_actions" });
  const packId = "pack-actions-only";
  // A legal declaration (manifest validator accepts allowActions instead of
  // allowOperations). It used to mint `empty_scope` forever, which left an
  // install-permitted pack permanently un-grantable.
  installPackWith(
    packId,
    [{ key: "kingdee-bills", provider: "kingdee", allowActions: ["kingdee.list_bills", "kingdee.create_bill"] }],
    { email },
  );
  const connector = fakeConnector();
  const result = await grants.grantPack({ email, packId, fetchImpl: connector.fetchImpl });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.granted.map((row) => row.bindingKey), ["kingdee-bills"]);
  assert.deepEqual(result.granted[0].actions, ["kingdee.list_bills", "kingdee.create_bill"]);

  const mint = connector.log.find((entry) => entry.method === "POST" && entry.pathname === "/api/tenant/pats");
  assert.deepEqual(mint.body.allowedOperations, []);
  assert.deepEqual(mint.body.allowedActions, ["kingdee.list_bills", "kingdee.create_bill"]);
});

test("5.2 a widening grant keeps the declared action rules", async () => {
  const email = "actions-keep@example.com";
  connectorCredentials.store({ email, token: "oct_parent_keep" });
  const packId = "pack-actions-keep";
  installPackWith(
    packId,
    [{ key: "kingdee-bills", provider: "kingdee", allowActions: ["kingdee.list_bills"] }],
    { email },
  );
  const connector = fakeConnector();
  await grants.grantPack({ email, packId, fetchImpl: connector.fetchImpl });
  // Widening by class must not silently re-mint an action-scoped binding with
  // no actions: the declaration's rules are re-sent every time.
  await grants.grantBinding({ email, packId, bindingKey: "kingdee-bills", operations: ["write"], fetchImpl: connector.fetchImpl });
  const minted = [...connector.pats.values()].find((pat) => pat.name === `pack:${packId}:kingdee-bills`);
  assert.deepEqual(minted.allowedActions, ["kingdee.list_bills"]);
  assert.deepEqual(minted.allowedOperations.map((row) => row.operationType), ["write"]);
});

test("5.2 a grant needs the user's own account: no account ⇒ nothing minted", async () => {
  const email = "no-account@example.com";
  const packId = "pack-no-account";
  db.upsertInstalledPack({ packId, name: packId, version: 1, manifest: { name: packId }, report: {}, source: "market" });
  db.upsertConnectorBindingLedgerRow({
    email, packId, packVersion: "1", bindingKey: "kingdee-cloud", provider: "kingdee",
    operations: ["read"], connectionId: "conn", status: "satisfied",
  });
  const connector = fakeConnector();
  const result = await grants.grantPack({ email, packId, fetchImpl: connector.fetchImpl });
  assert.deepEqual(result.granted, []);
  assert.equal(result.failed[0].code, "no_account");
  assert.equal(connector.log.length, 0, "no request left the platform");
  assert.equal(bindings.liveBindingToken(email, packId, "kingdee-cloud"), null);
});

// ── 5.3 Progressive grant ───────────────────────────────────────────────────

function seededBinding(email, packId, { key = "kingdee-cloud", provider = "kingdee", operations = ["read"] } = {}) {
  db.upsertInstalledPack({ packId, name: packId, version: 1, manifest: { name: packId }, report: {}, source: "market" });
  db.upsertConnectorBindingLedgerRow({
    email, packId, packVersion: "1", bindingKey: key, provider, operations,
    connectionId: "conn", status: "satisfied",
  });
}

test("5.3 a rejected write widens by union and is not replayed", async () => {
  const email = "progressive-write@example.com";
  connectorCredentials.store({ email, token: "oct_parent_write" });
  const packId = "pack-prog-write";
  seededBinding(email, packId, { operations: ["read"] });
  const connector = fakeConnector({
    actions: { "kingdee.create_bill": { provider: "kingdee", operationType: "write" } },
  });

  // The binding already holds read (the declared scope, granted by the dialog).
  // A write action is outside it, so the widened scope must be the union —
  // re-minting with just ["write"] would silently drop read from the token.
  await grants.grantBinding({ email, packId, bindingKey: "kingdee-cloud", operations: ["read"], fetchImpl: connector.fetchImpl });
  const before = connector.log.length;

  const result = await grants.grantForAction({
    email, packId, actionId: "kingdee.create_bill", fetchImpl: connector.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.operationType, "write");
  assert.equal(result.replayed, false, "the rejected call is never retried");
  assert.deepEqual([...result.operations].sort(), ["read", "write"], "scope is the union, not a replacement");

  // The only calls issued were the explain + the mint: no action execution.
  const after = connector.log.slice(before);
  assert.deepEqual(after.map((entry) => entry.pathname), ["/api/tenant/scope-explain", "/api/tenant/pats"]);
  assert.equal(connector.log.filter((entry) => entry.method === "POST").length, 2, "one dialog grant + one widening mint");

  // The token now carries the union.
  const minted = [...connector.pats.values()].find((pat) => pat.name === `pack:${packId}:kingdee-cloud`);
  assert.deepEqual(
    minted.allowedOperations.map((operation) => operation.operationType).sort(),
    ["read", "write"],
  );
  assert.equal(bindings.liveBindingToken(email, packId, "kingdee-cloud"), "oct_minted_2");
});

test("5.3 a rejected read is offered the same way — and still not replayed", async () => {
  const email = "progressive-read@example.com";
  connectorCredentials.store({ email, token: "oct_parent_read" });
  const packId = "pack-prog-read";
  seededBinding(email, packId, { operations: ["read"] });
  const connector = fakeConnector({
    actions: { "kingdee.list_bills": { provider: "kingdee", operationType: "read", allowed: false } },
  });

  const result = await grants.grantForAction({
    email, packId, actionId: "kingdee.list_bills", fetchImpl: connector.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.operationType, "read");
  assert.equal(result.replayed, false);
  assert.equal(connector.log.filter((entry) => entry.method === "POST").length, 1, "one mint, no execution");
});

test("5.3 an already-allowed action produces no card", async () => {
  const email = "progressive-allowed@example.com";
  connectorCredentials.store({ email, token: "oct_parent_allowed" });
  const packId = "pack-prog-allowed";
  seededBinding(email, packId, { operations: ["read"] });
  const connector = fakeConnector({
    actions: { "kingdee.list_bills": { provider: "kingdee", operationType: "read", allowed: true } },
  });
  const result = await grants.grantForAction({
    email, packId, actionId: "kingdee.list_bills", fetchImpl: connector.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "already_allowed");
  assert.equal(connector.log.filter((entry) => entry.method === "POST").length, 0, "no mint");
});

test("5.3 an unknown action is unknown, not a grantable rejection", async () => {
  const email = "progressive-unknown@example.com";
  connectorCredentials.store({ email, token: "oct_parent_unknown" });
  const packId = "pack-prog-unknown";
  seededBinding(email, packId);
  const connector = fakeConnector({ actions: {} });
  const result = await grants.grantForAction({
    email, packId, actionId: "kingdee.typo", fetchImpl: connector.fetchImpl,
  });
  assert.equal(result.ok, false);
  // The connector says `unknown_action` (404) — a typo, not a grantable denial.
  // Reading that as `http_404` would have sent the surface a "broken" verdict.
  assert.equal(result.code, "unknown_action");
  assert.equal(connector.log.filter((entry) => entry.method === "POST").length, 0);
});

// ── 5.4 One grant per (provider, operationType) ─────────────────────────────

test("5.4 the same class is granted once: a second rejection mints nothing", async () => {
  const email = "once-per-class@example.com";
  connectorCredentials.store({ email, token: "oct_parent_once" });
  const packId = "pack-once";
  seededBinding(email, packId, { operations: ["read"] });
  const connector = fakeConnector({
    actions: {
      "kingdee.list_bills": { provider: "kingdee", operationType: "read" },
      "kingdee.list_orders": { provider: "kingdee", operationType: "read", allowed: true },
    },
  });

  const first = await grants.grantForAction({ email, packId, actionId: "kingdee.list_bills", fetchImpl: connector.fetchImpl });
  assert.equal(first.ok, true);
  const mintsAfterFirst = connector.log.filter((entry) => entry.method === "POST" && entry.pathname === "/api/tenant/pats").length;
  assert.equal(mintsAfterFirst, 1);

  // The user already holds read on that provider: the second read action must
  // not produce another dialog, and granting again must not mint.
  const second = await grants.grantForAction({ email, packId, actionId: "kingdee.list_orders", fetchImpl: connector.fetchImpl });
  assert.equal(second.code, "already_allowed");
  const mintsAfterSecond = connector.log.filter((entry) => entry.method === "POST" && entry.pathname === "/api/tenant/pats").length;
  assert.equal(mintsAfterSecond, 1, "no second mint for an already-granted class");

  // Only one PAT exists for the binding, carrying read once.
  const pats = [...connector.pats.values()].filter((pat) => pat.name === `pack:${packId}:kingdee-cloud`);
  assert.equal(pats.length, 1);
  assert.deepEqual(pats[0].allowedOperations, [{ provider: "kingdee", operationType: "read" }]);
});

// ── 5.5 Revoke / stale ──────────────────────────────────────────────────────

test("5.5 revoke drops the local token and asks the connector to revoke the PAT", async () => {
  const email = "revoke@example.com";
  connectorCredentials.store({ email, token: "oct_parent_revoke" });
  const packId = "pack-revoke-flow";
  seededBinding(email, packId);
  const connector = fakeConnector();
  await grants.grantBinding({ email, packId, bindingKey: "kingdee-cloud", fetchImpl: connector.fetchImpl });
  const slot = bindings.bindingSlot(packId, "kingdee-cloud");
  assert.equal(bindings.liveBindingToken(email, packId, "kingdee-cloud"), "oct_minted_1");

  const result = await grants.revokeBinding({ email, packId, bindingKey: "kingdee-cloud", fetchImpl: connector.fetchImpl });
  assert.equal(result.removed, true);
  assert.equal(result.revokedOnConnector, true, "the connector was asked to revoke");
  assert.equal(db.getConnectorBinding(email, slot), null);
  assert.equal(connector.pats.size, 0, "no live PAT left behind");
  // The ledger falls back to "needs a grant", not to "connected".
  assert.equal(
    bindings.listBindings(email, packId).find((row) => row.bindingKey === "kingdee-cloud").status,
    "missing",
  );
});

test("5.5 revoke still removes the local token when the connector is unreachable", async () => {
  const email = "revoke-offline@example.com";
  connectorCredentials.store({ email, token: "oct_parent_offline" });
  const packId = "pack-revoke-offline";
  seededBinding(email, packId);
  db.setConnectorBinding({ email, slot: bindings.bindingSlot(packId, "kingdee-cloud"), token: "oct_local_only", patId: "pat-x" });

  const result = await grants.revokeBinding({
    email, packId, bindingKey: "kingdee-cloud",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(result.removed, true);
  assert.equal(result.revokedOnConnector, false, "best effort: a connector outage never blocks the revoke");
  assert.equal(bindings.liveBindingToken(email, packId, "kingdee-cloud"), null);
});

test("5.5 a 401 flips one binding to stale and does not switch to another connection", async () => {
  const email = "stale-flow@example.com";
  connectorCredentials.store({ email, token: "oct_parent_stale" });
  const packId = "pack-stale-flow";
  // Declared in the manifest so re-resolution re-reads exactly these two
  // bindings — a ledger row the manifest does not name becomes `deprecated`,
  // which is a different state and would hide the stale case.
  installPackWith(
    packId,
    [decl({ key: "kingdee-cloud" }), decl({ key: "payments", provider: "alipay", allowOperations: ["read"] })],
    { email },
  );
  db.setConnectorBinding({ email, slot: bindings.bindingSlot(packId, "kingdee-cloud"), token: "oct_kd" });
  db.setConnectorBinding({ email, slot: bindings.bindingSlot(packId, "payments"), token: "oct_al" });

  assert.equal(bindings.markSlotInvalid(email, bindings.bindingSlot(packId, "kingdee-cloud")), true);
  const rows = bindings.listBindings(email, packId);
  assert.equal(rows.find((row) => row.bindingKey === "kingdee-cloud").status, "stale");
  assert.equal(rows.find((row) => row.bindingKey === "payments").status, "satisfied");
  assert.equal(bindings.liveBindingToken(email, packId, "payments"), "oct_al", "sibling untouched");

  // Re-resolution reports stale for that binding; it does NOT silently reroute
  // to another connection of the same provider (spec: 不自动改选).
  const client = bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_parent_stale",
    fetchImpl: fakeConnector({
      coverage: { kingdee: {}, alipay: {} },
      connections: [
        { id: "conn-other", service: "kingdee", connectionName: "账套B", configured: true },
        { id: "conn-al", service: "alipay", connectionName: "merchant", configured: true },
      ],
    }).fetchImpl,
  });
  const { bindings: resolved } = await grants.refreshPackBindings({ email, packId, client });
  const kd = resolved.find((row) => row.bindingKey === "kingdee-cloud");
  assert.equal(kd.status, "stale");
  assert.equal(kd.connectionId, null, "no automatic re-selection of another connection");
});

// ── Route surface ───────────────────────────────────────────────────────────
// The grant flow is only real if the HTTP face exists. A module that is never
// mounted is exactly the failure mode a nearby-suite (studio drafting) is
// currently red on, so assert both halves: the router registers the five
// methods, and server.js actually calls it.

test("the binding router exposes the grant surface", async () => {
  const routes = await import("../server/routes/connector-bindings.js");
  const registered = [];
  const app = {
    get: (path, handler) => registered.push(["GET", path, typeof handler]),
    post: (path, handler) => registered.push(["POST", path, typeof handler]),
    // add-connector-role-mapping 4.3: choosing a system is a PUT/DELETE on a
    // role, and a router mounted without them would 404 the whole flow.
    put: (path, handler) => registered.push(["PUT", path, typeof handler]),
    delete: (path, handler) => registered.push(["DELETE", path, typeof handler]),
  };
  routes.registerConnectorBindingRoutes({ app, authEnabled: false, db: { isDbReady: () => true } });
  assert.deepEqual(
    registered.map(([method, path]) => `${method} ${path}`).sort(),
    [
      "DELETE /api/connector/role-mappings/:role",
      "GET /api/connector/bindings",
      "GET /api/connector/role-mappings",
      "POST /api/connector/bindings/grant",
      "POST /api/connector/bindings/grant-for-action",
      "POST /api/connector/bindings/refresh",
      "POST /api/connector/bindings/revoke",
      "PUT /api/connector/role-mappings/:role",
    ],
  );
  assert.ok(registered.every(([, , kind]) => kind === "function"));
});

test("server.js mounts the binding router", async () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "server.js"), "utf8");
  assert.match(source, /import \{ registerConnectorBindingRoutes \} from "\.\/server\/routes\/connector-bindings\.js";/);
  assert.match(source, /registerConnectorBindingRoutes\(ctx\);/);
});
