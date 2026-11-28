#!/usr/bin/env node
// ── Connector role mapping (add-connector-role-mapping) ──────────────────────
//
// A role binding says "this pack needs a WMS"; the identity says "mine is
// wangdian". That second sentence is the whole change, and the tests are about
// the three ways it can be wrong:
//
//   2.2  storage: one row per (identity, role); re-choosing the same system
//        rewrites nothing; another identity never inherits the choice.
//   3.1  resolution: the five shapes (mapped / unmapped / under-covering /
//        unconnected / unknown provider) are five DIFFERENT states. `unmapped`
//        in particular must not be answered by asking the catalog about the
//        role name — that turns "not chosen yet" into "we don't support it".
//   3.2  change: re-choosing a system drops the token minted for the old one
//        (it authorized the wrong system), while an unchanged mapping writes
//        nothing at all.
//   3.3  a role binding the pack dropped is `deprecated`: the token stays so a
//        running session is not broken mid-flight.
//   4.1  an unmapped binding is not in the grantable set — no provider, no scope.
//   4.3  the HTTP face: list / choose / clear, candidates from the user's own
//        connections, and "we could not ask" as its own answer.
//   4.4  a mapping change recomputes EVERY pack that declares the role, not just
//        the one being looked at.
//
// The connector is the same small in-process fake the grants suite uses: we need
// its contract (catalog-coverage / connections / pats), not the real one.
//
//   node --test scripts/test-connector-role-mapping.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-role-mapping-"));
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
const routes = await import("../server/routes/connector-bindings.js");
await db.initDb();

const EMAIL = "role-owner@example.com";
const OTHER = "role-other@example.com";
connectorCredentials.store({ email: EMAIL, token: "oct_account_role" });
connectorCredentials.store({ email: OTHER, token: "oct_account_other" });

// ── The fake connector ───────────────────────────────────────────────────────
// Same contract as the grants suite: coverage answers with per-class gaps,
// connections answers the user's own systems, pats mints with the same-name
// union the real one has. `log` is how we prove the catalog was (not) asked.
function fakeConnector({ coverage = {}, connections = [] } = {}) {
  const log = [];
  const pats = new Map();
  let seq = 0;
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    log.push({ method, pathname, provider: searchParams.get("provider"), operations: searchParams.get("operations") });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

    if (pathname === "/api/tenant/pats" && method === "POST") {
      const body = JSON.parse(init.body);
      let union = body.allowedOperations ?? [];
      for (const [id, pat] of [...pats]) {
        if (pat.name !== body.name) continue;
        union = dedupeOperations([...union, ...pat.allowedOperations]);
        pats.delete(id);
      }
      seq += 1;
      const id = `pat-${seq}`;
      pats.set(id, { name: body.name, allowedOperations: union });
      return json(200, { token: `oct_minted_${seq}`, id, name: body.name });
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

const roleDecl = (over = {}) => ({
  key: "wms",
  provider: "wms",
  providerRole: true,
  allowOperations: ["read"],
  optional: false,
  ...over,
});

const clientOf = (fake) => bindings.createConnectorClient({
  origin: "https://connector.example.test",
  token: "oct_account_role",
  fetchImpl: fake.fetchImpl,
});

function installPack(packId, connectorBindings, { version = "1.0.0" } = {}) {
  db.upsertInstalledPack({
    packId,
    name: packId,
    version,
    manifest: { name: packId, connector_bindings: connectorBindings },
    report: {},
    source: "market",
  });
}

function ledgerUpdatedAt(email, packId, bindingKey) {
  return db
    .getDb()
    .prepare("SELECT updated_at AS updatedAt FROM connector_binding_ledger WHERE email = ? AND pack_id = ? AND binding_key = ?")
    .get(email, packId, bindingKey)?.updatedAt ?? null;
}

// ── 2.2 Storage ─────────────────────────────────────────────────────────────

test("2.2 mapping: one row per (identity, role), re-choosing the same system writes nothing", () => {
  const first = db.setConnectorRoleMapping(EMAIL, "wms", "wangdian");
  assert.equal(first.provider, "wangdian");
  // Force an old stamp so "nothing was rewritten" is observable rather than
  // merely plausible (same-millisecond writes would hide the difference).
  db.getDb()
    .prepare("UPDATE connector_role_mappings SET updated_at = '2000-01-01T00:00:00.000Z' WHERE email = ? AND role = ?")
    .run(EMAIL, "wms");
  const again = db.setConnectorRoleMapping(EMAIL, "wms", "wangdian");
  assert.equal(again.provider, "wangdian");
  assert.equal(again.updatedAt, "2000-01-01T00:00:00.000Z", "repeat choice must not rewrite the row");
  assert.equal(db.listConnectorRoleMappings(EMAIL).length, 1);
});

test("2.2 mapping: another identity never inherits a choice, and clearing is reversible", () => {
  assert.equal(db.getConnectorRoleMapping(OTHER, "wms"), null);
  db.setConnectorRoleMapping(OTHER, "wms", "sf_express");
  assert.equal(db.getConnectorRoleMapping(EMAIL, "wms").provider, "wangdian");
  assert.equal(db.getConnectorRoleMapping(OTHER, "wms").provider, "sf_express");

  assert.equal(db.deleteConnectorRoleMapping(EMAIL, "wms"), true);
  assert.equal(db.getConnectorRoleMapping(EMAIL, "wms"), null);
  assert.equal(db.getConnectorRoleMapping(OTHER, "wms").provider, "sf_express", "deleting one identity leaves the other alone");
});

// ── 3.1 The five resolution shapes ──────────────────────────────────────────

test("3.1 mapped + connected + covered ⇒ satisfied, ledger records role and system", async () => {
  const email = "resolve-mapped@example.com";
  connectorCredentials.store({ email, token: "oct_mapped" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-mapped", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {} },
    connections: [{ id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true }],
  });
  const { bindings: rows } = await grants.refreshPackBindings({ email, packId: "pack-mapped", client: clientOf(fake) });

  assert.equal(rows[0].status, "satisfied");
  assert.equal(rows[0].provider, "wangdian", "the ledger carries the chosen system, not the role name");
  assert.equal(rows[0].role, "wms");
  assert.equal(rows[0].connectionId, "conn-wd");
  assert.equal(db.getConnectorBindingLedgerRow(email, "pack-mapped", "wms").role, "wms");
});

test("3.1 no mapping ⇒ unmapped, and the catalog is never asked about the role name", async () => {
  const email = "resolve-unmapped@example.com";
  connectorCredentials.store({ email, token: "oct_unmapped" });
  installPack("pack-unmapped", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {}, wms: {} },
    connections: [{ id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true }],
  });
  const { bindings: rows, gate } = await grants.refreshPackBindings({ email, packId: "pack-unmapped", client: clientOf(fake) });

  assert.equal(rows[0].status, "unmapped");
  assert.equal(rows[0].reason, "role_not_mapped:wms");
  assert.equal(
    fake.log.some((entry) => entry.pathname === "/api/tenant/catalog-coverage" && entry.provider === "wms"),
    false,
    "asking the catalog about the role name would answer `unknown provider` — a product gap it is not",
  );
  assert.equal(gate.connected, false, "an unmapped non-optional binding leaves the pack unconnected");
  assert.deepEqual(gate.unresolved.map((item) => [item.bindingKey, item.status, item.role]), [["wms", "unmapped", "wms"]]);
});

test("3.1 mapped provider under-covers ⇒ unwired with the gap, and alternatives are NOT tried", async () => {
  const email = "resolve-gap@example.com";
  connectorCredentials.store({ email, token: "oct_gap" });
  db.setConnectorRoleMapping(email, "wms", "kuaidi100");
  // The declaration still lists an alternative, which must be ignored once the
  // user has chosen: silently switching systems would contradict the status face.
  installPack("pack-gap", [roleDecl({ allowOperations: ["read", "write"], alternativeProviders: ["kingdee"] })]);
  const fake = fakeConnector({
    coverage: { kuaidi100: { gaps: ["write"] }, kingdee: {} },
    connections: [
      { id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true },
      { id: "conn-q", service: "kuaidi100", connectionName: "快递", configured: true },
    ],
  });
  const { bindings: rows } = await grants.refreshPackBindings({ email, packId: "pack-gap", client: clientOf(fake) });

  assert.equal(rows[0].status, "unwired");
  assert.equal(rows[0].reason, "catalog_gap:write");
  assert.equal(rows[0].provider, "kuaidi100", "the mapped system stays on the row so the card can offer a change");
  assert.equal(
    fake.log.some((entry) => entry.provider === "kingdee"),
    false,
    "a chosen system is not overridden by an alternative",
  );
});

test("3.1 mapped but no connection ⇒ missing, not unmapped", async () => {
  const email = "resolve-missing@example.com";
  connectorCredentials.store({ email, token: "oct_missing" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-missing", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {} },
    connections: [{ id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true }],
  });
  const { bindings: rows } = await grants.refreshPackBindings({ email, packId: "pack-missing", client: clientOf(fake) });

  assert.equal(rows[0].status, "missing");
  assert.equal(rows[0].reason, "no_connection");
});

test("3.1 mapped to a provider the catalog no longer knows ⇒ unwired, named", async () => {
  const email = "resolve-ghost@example.com";
  connectorCredentials.store({ email, token: "oct_ghost" });
  db.setConnectorRoleMapping(email, "wms", "ghost-wms");
  installPack("pack-ghost", [roleDecl()]);
  const fake = fakeConnector({ coverage: {}, connections: [] });
  const { bindings: rows } = await grants.refreshPackBindings({ email, packId: "pack-ghost", client: clientOf(fake) });

  assert.equal(rows[0].status, "unwired");
  assert.equal(rows[0].reason, "unknown_provider:ghost-wms");
});

// ── 3.2 Change detection ────────────────────────────────────────────────────

test("3.2 re-choosing a system drops the token minted for the old one; an unchanged mapping writes nothing", async () => {
  const email = "resolve-change@example.com";
  connectorCredentials.store({ email, token: "oct_change" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-change", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {}, kuaidi100: {} },
    connections: [
      { id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true },
      { id: "conn-q", service: "kuaidi100", connectionName: "快递", configured: true },
    ],
  });
  const client = clientOf(fake);

  const first = await grants.refreshPackBindings({ email, packId: "pack-change", client });
  assert.equal(first.bindings[0].status, "satisfied");
  const stamp = ledgerUpdatedAt(email, "pack-change", "wms");
  assert.ok(stamp);

  // Same mapping, same world: a second resolution must not rewrite the row.
  await grants.refreshPackBindings({ email, packId: "pack-change", client });
  assert.equal(ledgerUpdatedAt(email, "pack-change", "wms"), stamp, "an unchanged mapping is not a declaration change");

  const grant1 = await grants.grantPack({ email, packId: "pack-change", fetchImpl: fake.fetchImpl });
  assert.deepEqual(grant1.granted.map((row) => row.provider), ["wangdian"]);
  assert.equal(bindings.liveBindingToken(email, "pack-change", "wms"), "oct_minted_1");

  // Re-choose: the old token authorized wangdian, which is no longer the answer.
  db.setConnectorRoleMapping(email, "wms", "kuaidi100");
  const changed = await grants.refreshPackBindings({ email, packId: "pack-change", client });
  assert.equal(changed.bindings[0].provider, "kuaidi100");
  assert.equal(changed.bindings[0].status, "satisfied");
  assert.equal(bindings.liveBindingToken(email, "pack-change", "wms"), null, "the old system's token is gone");
  assert.equal(changed.bindings[0].grantedAt, null, "and its grant stamp does not outlive it");
  assert.deepEqual(changed.gate.pendingGrant.map((row) => row.bindingKey), ["wms"]);

  const grant2 = await grants.grantPack({ email, packId: "pack-change", fetchImpl: fake.fetchImpl });
  assert.equal(grant2.granted[0].provider, "kuaidi100");
  assert.equal(bindings.liveBindingToken(email, "pack-change", "wms"), "oct_minted_2");
});

test("3.2 a role row keeps its role through revoke and a 401 (full-row upserts must not blank it)", async () => {
  const email = "resolve-role-survives@example.com";
  connectorCredentials.store({ email, token: "oct_survive" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-survive", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {} },
    connections: [{ id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true }],
  });
  const client = clientOf(fake);
  await grants.refreshPackBindings({ email, packId: "pack-survive", client });
  await grants.grantPack({ email, packId: "pack-survive", fetchImpl: fake.fetchImpl });

  await grants.revokeBinding({ email, packId: "pack-survive", bindingKey: "wms", fetchImpl: fake.fetchImpl });
  assert.equal(db.getConnectorBindingLedgerRow(email, "pack-survive", "wms").role, "wms", "revoke must not un-role the binding");

  await grants.refreshPackBindings({ email, packId: "pack-survive", client });
  bindings.markSlotInvalid(email, bindings.bindingSlot("pack-survive", "wms"));
  assert.equal(db.getConnectorBindingLedgerRow(email, "pack-survive", "wms").role, "wms", "a 401 must not un-role the binding");
});

// ── 3.3 Deprecation ─────────────────────────────────────────────────────────

test("3.3 a role binding the pack drops becomes deprecated and keeps its token", async () => {
  const email = "resolve-deprecated@example.com";
  connectorCredentials.store({ email, token: "oct_dep" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-dep", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {}, kingdee: {} },
    connections: [
      { id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true },
      { id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true },
    ],
  });
  const client = clientOf(fake);
  await grants.refreshPackBindings({ email, packId: "pack-dep", client });
  await grants.grantPack({ email, packId: "pack-dep", fetchImpl: fake.fetchImpl });
  assert.equal(bindings.liveBindingToken(email, "pack-dep", "wms"), "oct_minted_1");

  // The new pack version no longer declares `wms`.
  installPack("pack-dep", [roleDecl({ key: "erp", provider: "kingdee", providerRole: false })], { version: "2.0.0" });
  await grants.refreshPackBindings({ email, packId: "pack-dep", client });

  const row = db.getConnectorBindingLedgerRow(email, "pack-dep", "wms");
  assert.equal(row.status, "deprecated");
  assert.equal(row.role, "wms", "the ledger keeps what it was");
  assert.equal(bindings.liveBindingToken(email, "pack-dep", "wms"), "oct_minted_1", "a running session is not broken mid-flight");
});

// ── 4.1 Grant set ───────────────────────────────────────────────────────────

test("4.1 the grantable set excludes unmapped rows: they are deferred, not failed", async () => {
  const email = "grant-deferred@example.com";
  connectorCredentials.store({ email, token: "oct_grant" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack(
    "pack-grant",
    [roleDecl({ key: "wms" }), roleDecl({ key: "supplier-portal", provider: "supplier-portal" })],
  );
  const fake = fakeConnector({
    coverage: { wangdian: {} },
    connections: [{ id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true }],
  });
  await grants.refreshPackBindings({ email, packId: "pack-grant", client: clientOf(fake) });

  const result = await grants.grantPack({ email, packId: "pack-grant", fetchImpl: fake.fetchImpl });
  assert.deepEqual(result.granted.map((row) => row.bindingKey), ["wms"]);
  assert.deepEqual(result.failed, [], "unchosen is not a failure of the grant call");
  assert.deepEqual(result.deferred.map((row) => [row.bindingKey, row.role, row.code]), [
    ["supplier-portal", "supplier-portal", "unmapped"],
  ]);
  assert.equal(bindings.liveBindingToken(email, "pack-grant", "supplier-portal"), null, "no provider, no token");
});

// ── 4.3 Route surface ───────────────────────────────────────────────────────

// A dispatcher, not express: the handlers are what 4.3 is about, and the whole
// file already runs against an in-process connector.
function fakeApp(ctx) {
  const table = [];
  const add = (method) => (routePath, handler) => table.push({ method, path: routePath, handler });
  const app = { get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };
  routes.registerConnectorBindingRoutes({ app, authEnabled: true, db, ...ctx });

  const parse = (routePath, segments) => {
    const wanted = routePath.split("/").filter(Boolean);
    if (wanted.length !== segments.length) return null;
    const params = {};
    for (let index = 0; index < wanted.length; index += 1) {
      const part = wanted[index];
      if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[index]);
      else if (part !== segments[index]) return null;
    }
    return params;
  };

  return {
    async call(method, url, { body = null, email = EMAIL } = {}) {
      const [pathname, queryString] = url.split("?");
      const segments = pathname.split("/").filter(Boolean);
      let match = null;
      for (const entry of table) {
        if (entry.method !== method) continue;
        const params = parse(entry.path, segments);
        if (params) { match = { entry, params }; break; }
      }
      if (!match) throw new Error(`no route for ${method} ${url}`);
      const req = { params: match.params, query: Object.fromEntries(new URLSearchParams(queryString ?? "")), body, ssoUser: { email } };
      const out = { status: 200, body: null };
      const res = {
        status(code) { out.status = code; return res; },
        json(payload) { out.body = payload; return res; },
      };
      await match.entry.handler(req, res);
      return out;
    },
  };
}

async function withConnector(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("4.3 GET lists each declared role with its mapping and only usable candidates", async () => {
  const email = "route-list@example.com";
  connectorCredentials.store({ email, token: "oct_route" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-route", [roleDecl({ key: "wms" }), roleDecl({ key: "carrier-portal", provider: "carrier-portal" })]);
  const fake = fakeConnector({
    coverage: {
      wangdian: {},
      kingdee: {},
      acme: { gaps: ["read"] },
    },
    connections: [
      { id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true },
      { id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true },
      { id: "conn-acme", service: "acme", connectionName: "自建", configured: true },
    ],
  });
  await grants.refreshPackBindings({ email, packId: "pack-route", client: clientOf(fake) });

  const app = fakeApp({});
  const response = await withConnector(fake, () => app.call("GET", "/api/connector/role-mappings", { email }));
  assert.equal(response.status, 200);
  const wms = response.body.mappings.find((entry) => entry.role === "wms");
  const carrier = response.body.mappings.find((entry) => entry.role === "carrier-portal");

  assert.equal(wms.provider, "wangdian");
  assert.deepEqual(wms.operations, ["read"]);
  assert.deepEqual(wms.candidates.map((row) => row.provider).sort(), ["kingdee", "wangdian"]);
  // Connected but under-covering: named with its gap instead of silently dropped.
  assert.deepEqual(wms.rejected, [{ provider: "acme", gaps: ["read"] }]);
  assert.equal(wms.candidatesState.ok, true);

  // A system with no connection is not a candidate at all (it could not be used),
  // and there is no catalog browse to offer it from.
  assert.equal(wms.candidates.some((row) => row.provider === "sf_express"), false);

  assert.equal(carrier.provider, null, "nothing chosen yet");
  assert.equal(carrier.optional, false);
});

test("4.3 GET reports an unreachable connector as its own state, not as an empty list", async () => {
  const email = "route-unreachable@example.com";
  installPack("pack-route-dead", [roleDecl()]);
  // No connector account: the resolution records the role (it is a declaration
  // fact) and reports `undetermined` — "we could not ask".
  const resolved = await grants.refreshPackBindings({ email, packId: "pack-route-dead" });
  assert.equal(resolved.bindings[0].status, "undetermined");
  assert.equal(resolved.bindings[0].role, "wms");
  const app = fakeApp({});
  const response = await app.call("GET", "/api/connector/role-mappings", { email });
  assert.equal(response.status, 200);
  const entry = response.body.mappings.find((row) => row.role === "wms");
  assert.deepEqual(entry.candidatesState, { ok: false, code: "connector_not_configured" });
  assert.deepEqual(entry.candidates, []);
});

test("4.3 PUT chooses a system, recomputes, and validates shape without judging the catalog", async () => {
  const email = "route-put@example.com";
  connectorCredentials.store({ email, token: "oct_put" });
  installPack("pack-put", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {} },
    connections: [{ id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true }],
  });
  await grants.refreshPackBindings({ email, packId: "pack-put", client: clientOf(fake) });
  const app = fakeApp({});

  const empty = await app.call("PUT", "/api/connector/role-mappings/wms", { email, body: { provider: "  " } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "invalid_provider");

  const blank = await app.call("PUT", "/api/connector/role-mappings/%20", { email, body: { provider: "wangdian" } });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, "invalid_role");

  // A role no installed pack declares: 200 with nothing changed would read as
  // success, so it is named instead.
  const ghostRole = await app.call("PUT", "/api/connector/role-mappings/erp", { email, body: { provider: "kingdee" } });
  assert.equal(ghostRole.status, 404);
  assert.equal(ghostRole.body.code, "role_not_declared");
  assert.equal(db.getConnectorRoleMapping(email, "erp"), null, "no ghost row is stored");

  const ok = await withConnector(fake, () => app.call("PUT", "/api/connector/role-mappings/wms", { email, body: { provider: "wangdian" } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mapping.provider, "wangdian");
  const pack = ok.body.refresh.packs.find((row) => row.packId === "pack-put");
  assert.equal(pack.bindings[0].status, "satisfied");
  assert.equal(pack.bindings[0].role, "wms");
  assert.equal(pack.bindings[0].provider, "wangdian", "the card can render the new state from this payload");
  assert.equal(pack.gate.connected, false, "still needs the grant");

  // A provider the catalog has never heard of is a RESOLUTION answer, not a 400.
  const ghost = await withConnector(fake, () => app.call("PUT", "/api/connector/role-mappings/wms", { email, body: { provider: "ghost-wms" } }));
  assert.equal(ghost.status, 200);
  assert.equal(ghost.body.mapping.provider, "ghost-wms");
  const ghostPack = ghost.body.refresh.packs.find((row) => row.packId === "pack-put");
  assert.equal(ghostPack.bindings[0].status, "unwired");
  assert.match(ghostPack.bindings[0].reason, /unknown_provider/);
});

test("4.3 DELETE clears the choice and the role goes back to unmapped", async () => {
  const email = "route-delete@example.com";
  connectorCredentials.store({ email, token: "oct_del" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-del", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {} },
    connections: [{ id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true }],
  });
  await grants.refreshPackBindings({ email, packId: "pack-del", client: clientOf(fake) });
  const app = fakeApp({});

  const response = await withConnector(fake, () => app.call("DELETE", "/api/connector/role-mappings/wms", { email }));
  assert.equal(response.status, 200);
  assert.equal(response.body.deleted, true);
  assert.equal(response.body.mapping, null);
  assert.equal(db.getConnectorRoleMapping(email, "wms"), null);
  const pack = response.body.refresh.packs.find((row) => row.packId === "pack-del");
  assert.equal(pack.bindings[0].status, "unmapped", "clearing does not fall back to any provider");
});

// ── 4.4 Cross-pack recompute ────────────────────────────────────────────────

test("4.4 a mapping change recomputes every pack that declares the role", async () => {
  const email = "cross-pack@example.com";
  connectorCredentials.store({ email, token: "oct_cross" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  installPack("pack-x", [roleDecl()]);
  installPack("pack-y", [roleDecl()]);
  const fake = fakeConnector({
    coverage: { wangdian: {}, kuaidi100: {} },
    connections: [
      { id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true },
      { id: "conn-q", service: "kuaidi100", connectionName: "快递", configured: true },
    ],
  });
  const client = clientOf(fake);
  for (const packId of ["pack-x", "pack-y"]) {
    await grants.refreshPackBindings({ email, packId, client });
    await grants.grantPack({ email, packId, fetchImpl: fake.fetchImpl });
  }
  assert.equal(bindings.liveBindingToken(email, "pack-x", "wms"), "oct_minted_1");
  assert.equal(bindings.liveBindingToken(email, "pack-y", "wms"), "oct_minted_2");

  db.setConnectorRoleMapping(email, "wms", "kuaidi100");
  const refresh = await grants.refreshRoleBindings({ email, role: "wms", client });
  assert.equal(refresh.ok, true);
  assert.deepEqual(refresh.packs.map((row) => row.packId).sort(), ["pack-x", "pack-y"]);

  for (const packId of ["pack-x", "pack-y"]) {
    const row = db.getConnectorBindingLedgerRow(email, packId, "wms");
    assert.equal(row.provider, "kuaidi100", `${packId} follows the new choice`);
    assert.equal(row.role, "wms");
    assert.equal(bindings.liveBindingToken(email, packId, "wms"), null, `${packId}'s old token was dropped`);
  }
});

test("4.4 clearing a mapping does not touch an unrelated role in the same packs", async () => {
  const email = "cross-pack-isolated@example.com";
  connectorCredentials.store({ email, token: "oct_cross_iso" });
  db.setConnectorRoleMapping(email, "wms", "wangdian");
  db.setConnectorRoleMapping(email, "erp", "kingdee");
  installPack(
    "pack-iso",
    [roleDecl({ key: "wms" }), roleDecl({ key: "erp", provider: "erp" })],
  );
  const fake = fakeConnector({
    coverage: { wangdian: {}, kingdee: {} },
    connections: [
      { id: "conn-wd", service: "wangdian", connectionName: "仓库A", configured: true },
      { id: "conn-kd", service: "kingdee", connectionName: "账套A", configured: true },
    ],
  });
  const client = clientOf(fake);
  await grants.refreshPackBindings({ email, packId: "pack-iso", client });
  await grants.grantPack({ email, packId: "pack-iso", fetchImpl: fake.fetchImpl });
  const erpToken = bindings.liveBindingToken(email, "pack-iso", "erp");
  assert.ok(erpToken);

  db.deleteConnectorRoleMapping(email, "wms");
  await grants.refreshRoleBindings({ email, role: "wms", client });

  assert.equal(db.getConnectorBindingLedgerRow(email, "pack-iso", "wms").status, "unmapped");
  assert.equal(bindings.liveBindingToken(email, "pack-iso", "wms"), null);
  assert.equal(bindings.liveBindingToken(email, "pack-iso", "erp"), erpToken, "the other role keeps its token");
});

// ── Router registration ─────────────────────────────────────────────────────

test("the binding router exposes the role-mapping surface", () => {
  const registered = [];
  const app = {
    get: (routePath) => registered.push(`GET ${routePath}`),
    post: (routePath) => registered.push(`POST ${routePath}`),
    put: (routePath) => registered.push(`PUT ${routePath}`),
    delete: (routePath) => registered.push(`DELETE ${routePath}`),
  };
  routes.registerConnectorBindingRoutes({ app, authEnabled: false, db: { isDbReady: () => true } });
  for (const expected of [
    "GET /api/connector/role-mappings",
    "PUT /api/connector/role-mappings/:role",
    "DELETE /api/connector/role-mappings/:role",
  ]) {
    assert.ok(registered.includes(expected), `missing ${expected}`);
  }
});
