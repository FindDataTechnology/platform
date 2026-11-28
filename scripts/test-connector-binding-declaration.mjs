#!/usr/bin/env node
// ── The author's words reach the grant screen ───────────────────────────────
//
// `connector_bindings` has two families of fields: the machine contract
// (key/provider/allowOperations…) and prose the author writes for the customer
// (external_system / surface / direction / credential / note). The ledger
// records the contract and nothing else — it is a decision record — so a grant
// screen built from ledger rows could only ever show a service id. Three
// published connector packs already write that prose for a reason ("客户在连接器
// 卡片选定自己实际在用的 WMS"); until this join existed, nobody could read it.
//
// What is pinned here, on the real route handler:
//   · the prose is joined from the installed manifest and travels under
//     `declaration` — trimmed, only the non-empty fields;
//   · a binding whose author wrote no prose carries NO `declaration` key, so the
//     UI can tell "said nothing" from "said something we dropped";
//   · whitespace-only prose is "said nothing";
//   · a ledger row whose pack is gone (uninstalled, or a key the pack renamed)
//     still reports its state — a missing declaration is not an error;
//   · the machine contract is unchanged by any of it.
//
//   node --test scripts/test-connector-binding-declaration.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "binding-declaration-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.chdir(TMP);
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const db = await import("../db.js");
const bindingRoutes = await import("../server/routes/connector-bindings.js");
await db.initDb();

const EMAIL = "declaration@example.com";

// The real handler, mounted on a recorder — no HTTP bench, so a failure here is
// the projection's, not the harness's.
function mount() {
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
    put: (p, h) => routes.set(`PUT ${p}`, h),
    delete: (p, h) => routes.set(`DELETE ${p}`, h),
  };
  bindingRoutes.registerConnectorBindingRoutes({ app, authEnabled: false, db: { isDbReady: () => true } });
  return routes;
}

async function listBindings() {
  const handler = mount().get("GET /api/connector/bindings");
  assert.equal(typeof handler, "function", "GET /api/connector/bindings must be registered");
  let body = null;
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  await handler({ query: {}, headers: {}, ssoUser: { email: EMAIL } }, res);
  assert.equal(res.statusCode, 200, "the listing must answer");
  return body.bindings;
}

// Every test looks its row up by pack: the listing returns all of this
// identity's rows, so positional indexing would silently assert about a
// neighbour's row the moment two tests share the database.
function rowOf(rows, packId, bindingKey = "wms") {
  const found = rows.find((row) => row.packId === packId && row.bindingKey === bindingKey);
  assert.ok(found, `expected a row for ${packId}:${bindingKey}`);
  return found;
}

function installPack(packId, bindings) {
  db.upsertInstalledPack({
    packId,
    name: packId,
    version: "1.0.0",
    manifest: { name: packId, connector_bindings: bindings },
    report: null,
  });
}

function ledgerRow(packId, bindingKey, extra = {}) {
  db.upsertConnectorBindingLedgerRow({
    email: EMAIL,
    packId,
    packVersion: "1.0.0",
    bindingKey,
    provider: extra.provider ?? "wms",
    operations: ["read"],
    status: extra.status ?? "missing",
    optional: false,
    role: extra.role ?? null,
  });
}

test("the pack's prose reaches the row, trimmed and complete", async () => {
  installPack("pack-prose", [
    {
      key: "wms",
      provider: "wms",
      allowOperations: ["read"],
      external_system: "  客户 WMS（品牌待定）  ",
      surface: "库存快照只读（日终账实对账）",
      direction: "read-only",
      credential: "BYOK：ERP_BYOK_WMS_*",
      note: "编排层零写 WMS",
      // Machine fields must NOT leak into the prose block.
      allowActions: undefined,
    },
  ]);
  ledgerRow("pack-prose", "wms");

  const row = rowOf(await listBindings(), "pack-prose");
  assert.deepEqual(row.declaration, {
    external_system: "客户 WMS（品牌待定）",
    surface: "库存快照只读（日终账实对账）",
    direction: "read-only",
    credential: "BYOK：ERP_BYOK_WMS_*",
    note: "编排层零写 WMS",
  });
  // The contract half is untouched by the join.
  assert.equal(row.provider, "wms");
  assert.deepEqual(row.operations, ["read"]);
  assert.equal(row.status, "missing");
});

test("no prose means no declaration key at all", async () => {
  installPack("pack-bare", [{ key: "wms", provider: "wms", allowOperations: ["read"] }]);
  ledgerRow("pack-bare", "wms");

  const row = rowOf(await listBindings(), "pack-bare");
  assert.equal(
    Object.hasOwn(row, "declaration"),
    false,
    "an empty object would read as 'the pack said something empty'",
  );
});

test("whitespace-only prose is the same as none", async () => {
  installPack("pack-blank", [
    { key: "wms", provider: "wms", allowOperations: ["read"], external_system: "   ", note: "\n\t" },
  ]);
  ledgerRow("pack-blank", "wms");

  const row = rowOf(await listBindings(), "pack-blank");
  assert.equal(Object.hasOwn(row, "declaration"), false);
});

test("a partially written binding carries only what was written", async () => {
  installPack("pack-partial", [
    { key: "wms", provider: "wms", allowOperations: ["read"], external_system: "金蝶云星空" },
  ]);
  ledgerRow("pack-partial", "wms");

  const row = rowOf(await listBindings(), "pack-partial");
  assert.deepEqual(row.declaration, { external_system: "金蝶云星空" });
});

test("a ledger row whose pack is gone still reports its state", async () => {
  // No installPack: the row survives an uninstall (or a key the pack renamed),
  // and an absent declaration must not turn into a 500 or an empty row.
  ledgerRow("pack-uninstalled", "wms");

  const row = rowOf(await listBindings(), "pack-uninstalled");
  assert.equal(row.packId, "pack-uninstalled");
  assert.equal(row.status, "missing");
  assert.equal(Object.hasOwn(row, "declaration"), false);
});

test("a variant of the same key gets the prose of the key it names", async () => {
  installPack("pack-two", [
    { key: "wms", provider: "wms", allowOperations: ["read"], external_system: "客户 WMS（品牌待定）" },
    { key: "erp", provider: "kingdee", allowOperations: ["read"], external_system: "金蝶云星空" },
  ]);
  ledgerRow("pack-two", "erp", { provider: "kingdee" });

  const erp = rowOf(await listBindings(), "pack-two", "erp");
  assert.deepEqual(erp.declaration, { external_system: "金蝶云星空" });
});
