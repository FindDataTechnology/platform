#!/usr/bin/env node
// ── The other two industry packs, consumed by the real binding chain ────────
//
// The template repo now ships machine-readable `connector_bindings` for all
// three verticals (2026-11-08). This file feeds the two NEW ones — restaurant
// chain and crossborder — through the actual resolver, not synthetic rows, so a
// typo in a role name, a provider that the catalog does not know, or an
// optionality that would block every install shows up here rather than in a
// customer's install gate.
//
// What is asserted per pack:
//   · the manifest passes `validatePackManifest` (the market's own gate);
//   · a role binding with no mapping resolves to `unmapped` and never asks the
//     catalog about the role name;
//   · a fixed-provider binding resolves against catalog coverage + the user's
//     connections, and an `alternativeProviders` set is honoured;
//   · because every binding in both packs is optional, an unconnected pack
//     installs and stays usable — the gate lists them as optional-unmet instead
//     of blocking (that optionality is a deliberate product decision, see the
//     template repo's docs §5);
//   · `grantPack` defers the unmapped rows instead of failing the call.
//
// The fixtures are snapshots of the template repo's pack.json (the same pattern
// as supply-chain-after.json): the point is to catch drift between what the pack
// says and what the resolver can actually do.
//
//   node --test scripts/test-industry-connector-packs.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "industry-connector-packs-"));
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

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, "..", "test", "fixtures", "connector-bindings");
const pack = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

const db = await import("../db.js");
const bindings = await import("../connector-bindings.js");
const grants = await import("../connector-grants.js");
const connectorCredentials = await import("../connector-credentials.js");
const { validatePackManifest } = await import("../lib/pack-manifest.js");
await db.initDb();

const EMAIL = "industry-packs@example.com";
connectorCredentials.store({ email: EMAIL, token: "oct_account_industry" });

function fakeConnector({ coverage = {}, connections = [] } = {}) {
  const log = [];
  const fetchImpl = async (url) => {
    const { pathname, searchParams } = new URL(url);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    log.push({ pathname, provider: searchParams.get("provider") });
    if (pathname === "/api/tenant/catalog-coverage") {
      const provider = searchParams.get("provider");
      if (!(provider in coverage)) return json(404, { error: { code: "unknown_provider" } });
      const wanted = (searchParams.get("operations") ?? "").split(",").filter(Boolean);
      const gaps = (coverage[provider].gaps ?? []).filter((gap) => wanted.includes(gap));
      return json(200, { provider, operations: [], gaps });
    }
    if (pathname === "/api/tenant/connections") return json(200, { connections });
    return json(404, { error: { code: "not_found" } });
  };
  return { fetchImpl, log };
}

function install(name, fixture) {
  const packId = name;
  db.upsertInstalledPack({
    packId,
    name: fixture.name,
    version: fixture.version,
    manifest: fixture,
    report: {},
    source: "market",
  });
  return packId;
}

const clientOf = (fake) =>
  bindings.createConnectorClient({
    origin: "https://connector.example.test",
    token: "oct_account_industry",
    fetchImpl: fake.fetchImpl,
  });

test("restaurant chain: a POS role is unmapped, payments resolve, nothing blocks the install", async () => {
  const fixture = pack("restaurant-connector-pack.json");
  assert.deepEqual(validatePackManifest(fixture), [], "the market's own gate must accept the pack");

  const packId = install("restaurant-chain-connector", fixture);
  const fake = fakeConnector({
    coverage: { wechatpay: {}, meituan: {} },
    connections: [
      { id: "conn-wx", service: "wechatpay", connectionName: "微信商户", configured: true },
      { id: "conn-mt", service: "meituan", connectionName: "美团商家", configured: true },
    ],
  });
  const { bindings: rows, gate } = await grants.refreshPackBindings({ email: EMAIL, packId, client: clientOf(fake) });

  const byKey = Object.fromEntries(rows.map((row) => [row.bindingKey, row]));
  assert.equal(byKey["pos-sales"].status, "unmapped", "no POS chosen yet");
  assert.equal(byKey["pos-sales"].role, "pos");
  assert.equal(
    fake.log.some((entry) => entry.pathname === "/api/tenant/catalog-coverage" && entry.provider === "pos"),
    false,
    "a role name must never be sent to the catalog as a provider",
  );
  assert.equal(byKey["payments-merchant"].status, "satisfied");
  assert.equal(byKey["delivery-settlement"].status, "satisfied");

  // Every binding is optional on purpose: nothing here blocks the install. The
  // pack is still not "connected" — the two satisfied bindings are ungranted, so
  // they sit in pendingGrant (the one-click dialog), which is a different fact
  // from "something is unresolved".
  assert.deepEqual(gate.unresolved, [], "no binding blocks this install");
  assert.ok(gate.optionalUnmet.some((row) => row.bindingKey === "pos-sales" && row.status === "unmapped"));
  assert.deepEqual(gate.pendingGrant.map((row) => row.bindingKey).sort(), ["delivery-settlement", "payments-merchant"]);
  assert.equal(gate.connected, false, "satisfied-but-ungranted is still not connected");
});

test("restaurant chain: the payment binding's alternatives are honoured, and an unmapped role is deferred", async () => {
  const fixture = pack("restaurant-connector-pack.json");
  const packId = "restaurant-chain-alt";
  install(packId, fixture);
  // Only alipay is connected: the primary (wechatpay) is absent from the
  // coverage map, so the resolver must walk alternativeProviders.
  const fake = fakeConnector({
    coverage: { alipay: {}, meituan: {} },
    connections: [
      { id: "conn-al", service: "alipay", connectionName: "支付宝商户", configured: true },
      { id: "conn-mt", service: "meituan", connectionName: "美团商家", configured: true },
    ],
  });
  const { bindings: rows } = await grants.refreshPackBindings({ email: EMAIL, packId, client: clientOf(fake) });
  const payments = rows.find((row) => row.bindingKey === "payments-merchant");
  assert.equal(payments.status, "satisfied");
  assert.equal(payments.provider, "alipay", "the ledger records the alternative actually resolved");

  const granted = await grants.grantPack({ email: EMAIL, packId });
  assert.ok(granted.deferred.some((row) => row.bindingKey === "pos-sales"), "unmapped is deferred, not failed");
  assert.deepEqual(granted.failed.filter((row) => row.bindingKey === "pos-sales"), []);
});

test("crossborder: shopify resolves by real id, the CN platform is a role", async () => {
  const fixture = pack("crossborder-connector-pack.json");
  assert.deepEqual(validatePackManifest(fixture), [], "the market's own gate must accept the pack");

  const packId = install("crossborder-connector", fixture);
  const fake = fakeConnector({
    coverage: { shopify: {} },
    connections: [{ id: "conn-sh", service: "shopify", connectionName: "店铺 A", configured: true }],
  });
  const { bindings: rows, gate } = await grants.refreshPackBindings({ email: EMAIL, packId, client: clientOf(fake) });
  const byKey = Object.fromEntries(rows.map((row) => [row.bindingKey, row]));

  assert.equal(byKey["shopify-store"].status, "satisfied");
  assert.equal(byKey["shopify-store"].provider, "shopify");
  assert.equal(byKey["shopify-store"].role, null, "a real service id is never a role");
  assert.equal(byKey["cn-commerce-store"].status, "unmapped");
  assert.equal(byKey["cn-commerce-store"].role, "cn-commerce");
  // Both optional → a Shopify-only customer installs and works, and vice versa.
  assert.deepEqual(gate.unresolved, [], "neither binding blocks");
  assert.deepEqual(gate.pendingGrant.map((row) => row.bindingKey), ["shopify-store"]);
});

test("crossborder: neither binding blocks, so either customer segment can install", async () => {
  const fixture = pack("crossborder-connector-pack.json");
  const packId = "crossborder-cn-only";
  install(packId, fixture);
  // A CN-only seller: no Shopify connection at all.
  const fake = fakeConnector({
    coverage: { shopify: {}, "cn-commerce": {} },
    connections: [{ id: "conn-cn", service: "cn-commerce", connectionName: "淘宝店", configured: true }],
  });
  const { gate } = await grants.refreshPackBindings({ email: EMAIL, packId, client: clientOf(fake) });
  assert.deepEqual(gate.unresolved, [], "a missing Shopify store must not block a CN-only seller");
  // Both are optional-unmet, and for two different reasons: the Shopify binding
  // has no connection (`missing`), the CN one has no system chosen yet
  // (`unmapped`) — connecting a *service* named cn-commerce does not answer a
  // role, because the role exists precisely so the customer names their platform.
  assert.deepEqual(
    gate.optionalUnmet.map((row) => [row.bindingKey, row.status]).sort(),
    [["cn-commerce-store", "unmapped"], ["shopify-store", "missing"]],
  );
  assert.deepEqual(gate.pendingGrant, [], "nothing can be granted before a system is chosen");
});
