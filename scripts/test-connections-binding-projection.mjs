// scripts/test-connections-binding-projection.mjs — add-connector-bindings 6.1
//
// GET /api/connections carries a binding projection on the connector entry:
// per-binding key / provider / operation classes / status / optional, plus a
// summary the card renders as "N packs need M bindings, K unresolved".
//
// The projection is a WHITELIST: a ledger row also holds the resolved
// connection id, and that may not reach the browser. Neither may a binding
// token or a PAT id — this test asserts the whole payload is free of credential
// material, not just the fields it expects. `granted`/`grantedAt` ARE projected
// on purpose (6.2: the card offers 「去授权」 or 「撤销授权」 accordingly, and
// 「授权于 …」 needs the stamp) — the user's own facts, not credential material.
//
// Run: node scripts/test-connections-binding-projection.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "connections-projection-"));
const prevDbPath = process.env.DB_PATH;
process.env.DB_PATH = join(tmp, "app.db");

const db = await import("../db.js");
await db.initDb();

const express = (await import("express")).default;
const { registerMiscRoutes } = await import("../server/routes/misc.js");

const EMAIL = "bindings@example.com";
const TOKEN = "oct_SECRET_binding_token_9f3a";

db.setConnectorCredential({ email: EMAIL, slot: "default", token: "oct_account_token", patId: "pat-1" });
db.setConnectorBinding({
  email: EMAIL,
  slot: "pack-a:kingdee",
  token: TOKEN,
  patId: "pat-binding-1",
  purpose: "pack:pack-a/kingdee",
  sourceAccount: "default",
});

// One pack, four bindings: satisfied / missing / optional-unwired / deprecated.
db.upsertConnectorBindingLedgerRow({
  email: EMAIL, packId: "pack-a", packVersion: "1", bindingKey: "kingdee",
  provider: "kingdee", operations: ["read", "write"], connectionId: "conn-1",
  status: "satisfied", optional: false, grantedAt: "2026-11-08T00:00:00.000Z",
});
db.upsertConnectorBindingLedgerRow({
  email: EMAIL, packId: "pack-a", packVersion: "1", bindingKey: "wms",
  provider: "wms", operations: ["read"], connectionId: null,
  status: "missing", optional: false,
});
db.upsertConnectorBindingLedgerRow({
  email: EMAIL, packId: "pack-a", packVersion: "1", bindingKey: "carrier",
  provider: "carrier", operations: ["read"], connectionId: null,
  status: "unwired", optional: true,
});
db.upsertConnectorBindingLedgerRow({
  email: EMAIL, packId: "pack-a", packVersion: "1", bindingKey: "dropped",
  provider: "legacy", operations: ["read"], connectionId: null,
  status: "deprecated", optional: false,
});
// add-connector-role-mapping 4.2: a role the user has not chosen a system for.
// `provider` holds the ROLE name and `role` says so; the card needs both to
// offer 「选择你的系统」 rather than 「去连接」.
db.upsertConnectorBindingLedgerRow({
  email: EMAIL, packId: "pack-b", packVersion: "1", bindingKey: "warehouse",
  provider: "wms", role: "wms", operations: ["read"], connectionId: null,
  status: "unmapped", optional: false,
});

function buildApp(email) {
  const app = express();
  app.use(express.json());
  if (email) app.use((req, _res, next) => { req.ssoUser = { email }; next(); });
  registerMiscRoutes({
    app,
    db,
    catalog: { list: () => [] },
    cron: { listJobs: () => [] },
    authEnabled: true,
    isAdminUser: () => false,
    PORT: 0,
    runtimeMcpOverlay: null,
    dshUpdateMcp: async () => {},
    splitPolicy: () => ({ locked: false, permissions: null }),
    requireAdmin: () => true,
  });
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

test("connector entry carries the binding projection and a summary (6.1)", async () => {
  const body = await withServer(buildApp(EMAIL), async (base) => {
    const res = await fetch(`${base}/api/connections`);
    assert.equal(res.status, 200);
    return res.json();
  });
  const connector = body.connections.find((c) => c.id === "connector");
  assert.ok(connector, "the connector entry must exist");
  assert.ok(Array.isArray(connector.bindings), "bindings projection missing");
  assert.equal(connector.bindings.length, 5);

  const kingdee = connector.bindings.find((b) => b.key === "kingdee");
  assert.deepEqual(kingdee, {
    packId: "pack-a",
    key: "kingdee",
    provider: "kingdee",
    // A fixed-provider binding carries the role face as "none": the card keys
    // its copy off these two fields for every row, not just role ones.
    role: null,
    providerRole: false,
    operations: ["read", "write"],
    status: "satisfied",
    optional: false,
    // 6.2's action: a live binding token exists for this row, so the card must
    // offer 「撤销授权」 and show when it was granted.
    granted: true,
    grantedAt: "2026-11-08T00:00:00.000Z",
  });
  const wms = connector.bindings.find((b) => b.key === "wms");
  assert.equal(wms.granted, false, "satisfied but un-granted → the card must offer 「去授权」");
  assert.equal(wms.grantedAt, null);
  const carrier = connector.bindings.find((b) => b.key === "carrier");
  assert.equal(carrier.status, "unwired", "unwired must survive as itself, never degrade to missing");
  assert.equal(carrier.optional, true);
  const warehouse = connector.bindings.find((b) => b.key === "warehouse");
  assert.equal(warehouse.status, "unmapped");
  assert.equal(warehouse.role, "wms", "the role name is what the card maps a system against");
  assert.equal(warehouse.providerRole, true);
  assert.equal(warehouse.granted, false);

  // Counts answer "what does my installed set still need": the deprecated row
  // is history, not work, so it must not inflate the numbers. `unwired` and
  // `unmapped` are each counted apart from `unresolved` — a capability gap and
  // an unmade choice are not the same todo, and neither is "we don't support it".
  assert.deepEqual(connector.bindingSummary, { packs: 2, bindings: 4, unresolved: 2, unwired: 1, unmapped: 1 });
  // Two negatives: the counts track their own rows (an unmade choice must not
  // be folded into the capability-gap bucket, nor the other way round).
  assert.equal(connector.bindingSummary.unmapped, connector.bindings.filter((b) => b.status === "unmapped").length);
  assert.equal(connector.bindingSummary.unwired, connector.bindings.filter((b) => b.status === "unwired").length);
  assert.equal(connector.bindings.filter((b) => b.status === "unmapped" && b.status === "unwired").length, 0);
});

test("the projection carries no credential material (6.1 negative case)", async () => {
  const body = await withServer(buildApp(EMAIL), async (base) => {
    const res = await fetch(`${base}/api/connections`);
    return res.json();
  });
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(TOKEN), "a binding token leaked into the status payload");
  assert.ok(!raw.includes("pat-1") && !raw.includes("pat-binding-1"), "a PAT id leaked into the status payload");
  assert.ok(!raw.includes("conn-1"), "the resolved connection id must not be projected");
  for (const row of body.connections.find((c) => c.id === "connector").bindings) {
    // The whitelist, exactly. `granted` is a boolean and `grantedAt` a display
    // stamp — neither is credential material, both are needed by the action.
    assert.deepEqual(Object.keys(row).sort(), [
      "granted", "grantedAt", "key", "operations", "optional", "packId", "provider", "providerRole", "role", "status",
    ]);
    assert.equal(typeof row.granted, "boolean");
    assert.ok(row.grantedAt === null || typeof row.grantedAt === "string", "grantedAt is display-only");
    assert.ok(!("connectionId" in row) && !("token" in row) && !("patId" in row), "no row leaks credential material");
  }
});

test("an identity with no ledger rows gets an empty projection, not a missing field", async () => {
  const body = await withServer(buildApp("nobody@example.com"), async (base) => {
    const res = await fetch(`${base}/api/connections`);
    return res.json();
  });
  const connector = body.connections.find((c) => c.id === "connector");
  assert.deepEqual(connector.bindings, []);
  assert.deepEqual(connector.bindingSummary, { packs: 0, bindings: 0, unresolved: 0, unwired: 0, unmapped: 0 });
});

test.after(async () => {
  if (prevDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = prevDbPath;
  rmSync(tmp, { recursive: true, force: true });
});
