#!/usr/bin/env node
// ── 舰队凭据包读面（change converge-line-identity-and-keys 4.1）──────────────
//
// 路由只做接线，所以这里盯的是"接错线会静默出错"的四处：
//   1. pack 的 `mcpServers[].registryName` 真的被解析到凭据 ref（线断了会
//      变成一个"零填写"的假绿灯）；
//   2. 注册表查不到的 server 进 `unknown`，不当成"不需要凭据"；
//   3. 没装过的 pack 进 `missingPacks`，不是静默跳过；
//   4. 未登录 401、DB 不可用 503（"读不到"与"不用填"不能同形）。
//
//   node --test --test-concurrency=1 scripts/test-fleet-credential-pack-route.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import express from "express";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "fleet-credential-pack-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const { registerAuth } = await import("../server/auth.js");
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");
const { registerFleetCredentialPackRoutes } = await import(
  "../server/routes/fleet-credential-pack.js"
);

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

//: 假市场：名字 → 条目。`credential_ref` 走注册表 metadata，与真实条目同形状。
function fakeExtensionStore(entries) {
  return {
    findMarketMcpEntry: async (name) => (name in entries ? entries[name] : null),
  };
}

function makeApp({ dbOverride = null, extensionStore } = {}) {
  const ctx = {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: false,
    logtoAuth: null,
    PAAS_BASE_URL: "https://platform.test",
    resolveSessionSecret: async () => "test-session-secret",
  };
  registerAuth(ctx);
  registerFleetCredentialPackRoutes({ ...ctx, db: dbOverride ?? db, extensionStore });
  return ctx.app;
}

function httpRequest(app, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${p}`, {
        method: body ? "POST" : "GET",
        headers: body ? { ...headers, "content-type": "application/json" } : headers,
        body: body ? JSON.stringify(body) : undefined,
      })
        .then(async (res) => resolve({ status: res.status, body: await res.json().catch(() => null) }))
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

const ALICE = { "x-forwarded-email": "alice@x.test", "x-forwarded-groups": "user" };

//: 造一个已安装 pack 行：形状与 db.getInstalledPack 的返回一致。
function seedPack(packId, registryNames) {
  db.upsertInstalledPack?.({
    packId,
    name: packId,
    version: "1.0.0",
    manifest: { mcpServers: registryNames.map((registryName) => ({ registryName })) },
  });
}

test("pack 的 registryName 被解析到凭据 ref；三条线共用门 K → 只要填 1 次", async () => {
  // 三个 server 都声明了同一条词元 ref（门 K 的形态）。
  // 形状照真实注册表条目：ref 在**顶层的 `credentialRef`**，不是 metadata 里
  // （`credentialRefForEntry()` 只认 `entry.credentialRef`；写错位置会静默落到
  // registry，于是"三条线一把钥"会变成"三处各填一次"——正是本项要消掉的东西）。
  const entries = {
    "lex-ops-mcp": { name: "lex-ops-mcp", credentialRef: "ciyuan-account" },
    "wire-ops-mcp": { name: "wire-ops-mcp", credentialRef: "ciyuan-account" },
    "paper-trading-mcp": { name: "paper-trading-mcp", credentialRef: "ciyuan-account" },
  };
  seedPack("pack-lex", ["lex-ops-mcp"]);
  seedPack("pack-wire", ["wire-ops-mcp"]);
  seedPack("pack-pt", ["paper-trading-mcp"]);

  const app = makeApp({ extensionStore: fakeExtensionStore(entries) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { packIds: ["pack-lex", "pack-wire", "pack-pt"] },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.fillsRequired, 1, "一把词元钥喂三条线，不能让属主填三次");
  assert.equal(r.body.fills[0].door, "customer-key");
  assert.deepEqual(r.body.fills[0].servers, ["lex-ops-mcp", "paper-trading-mcp", "wire-ops-mcp"]);
  assert.deepEqual(r.body.missingPacks, []);
});

test("未声明 credentialRef 时按线自有轨/注册表兜底：同一 pack 里两个 server 可能是两处填写", async () => {
  // 这是真实行为，不是测试凑数：`credentialRefForEntry()` 对 registryName
  // 落在 `WIRE_LINE_SERVERS` 的 server 返回该线自有 ref（wire-customer），
  // 其余落到 registry。所以"一个 pack 装完只要填一次"并不总成立——规划器
  // 必须如实报两次，否则属主填完 registry 仍然装不上柏讯那条。
  seedPack("pack-mixed", ["wire-ops-mcp", "some-registry-mcp"]);
  const entries = {
    "wire-ops-mcp": { name: "wire-ops-mcp" },
    "some-registry-mcp": { name: "some-registry-mcp" },
  };
  const app = makeApp({ extensionStore: fakeExtensionStore(entries) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { packIds: ["pack-mixed"] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.fillsRequired, 2, "两条不同的 ref 不能并成一次");
  assert.deepEqual(r.body.fills.map((f) => f.refName).sort(), ["registry", "wire-customer"]);
  assert.ok(r.body.fills.every((f) => f.door === "third-party"));
});

test("注册表查不到的 server 进 unknown，不被当成不需要凭据", async () => {
  seedPack("pack-ghost", ["does-not-exist-mcp"]);
  const app = makeApp({ extensionStore: fakeExtensionStore({}) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { packIds: ["pack-ghost"] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.unknown, [{ server: "does-not-exist-mcp", packId: "pack-ghost" }]);
  // 关键：unknown 不能静默变成"零填写"还报 satisfied。
  assert.equal(r.body.fillsRequired, 0);
  assert.deepEqual(r.body.doors, []);
});

test("没装过的 pack 进 missingPacks，不是静默跳过", async () => {
  seedPack("pack-lex2", ["lex-ops-mcp"]);
  const entries = { "lex-ops-mcp": { name: "lex-ops-mcp", credentialRef: "ciyuan-account" } };
  const app = makeApp({ extensionStore: fakeExtensionStore(entries) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { packIds: ["pack-lex2", "pack-never-installed"] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.missingPacks, ["pack-never-installed"]);
});

test("fleetId 入口：从模板 pack 与成员 packId 反推，跨三线只要 1 次", async () => {
  const entries = {
    "lex-ops-mcp": { name: "lex-ops-mcp", credentialRef: "ciyuan-account" },
    "wire-ops-mcp": { name: "wire-ops-mcp", credentialRef: "ciyuan-account" },
    "paper-trading-mcp": { name: "paper-trading-mcp", credentialRef: "ciyuan-account" },
  };
  seedPack("pack-a", ["lex-ops-mcp"]);
  seedPack("pack-b", ["wire-ops-mcp"]);
  seedPack("pack-c", ["paper-trading-mcp"]);

  // createFleet/createMember 都不铸 id（线上由路由铸），测试得自己给。
  const fleets = getFleetDatabase();
  const fleetId = "f-top-three";
  fleets.createFleet({
    id: fleetId,
    name: "跨三线",
    ownerEmail: "alice@x.test",
    sourceTemplate: { packId: "pack-a" },
  });
  [["pack-b", "柏讯"], ["pack-c", "模拟交易"]].forEach(([packId, title], i) => {
    fleets.createMember({
      id: `m-${i}`,
      fleetId,
      title,
      targetKind: "persona",
      targetId: `${packId}-agent`,
      packId,
    });
  });

  const app = makeApp({ extensionStore: fakeExtensionStore(entries) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { fleetId },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.fillsRequired, 1, "三条线共用一把词元钥，只能要一次");
  assert.deepEqual(r.body.fills[0].servers, ["lex-ops-mcp", "paper-trading-mcp", "wire-ops-mcp"]);
  assert.deepEqual(r.body.packIds.sort(), ["pack-a", "pack-b", "pack-c"], "来源要如实回带");
  assert.equal(r.body.fleetId, fleetId);
});

test("fleetId 查不到 → 404（不是空计划）", async () => {
  const app = makeApp({ extensionStore: fakeExtensionStore({}) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { fleetId: "no-such-fleet" },
  });
  assert.equal(r.status, 404);
});

test("空舰队 → 200 + 空计划 + emptyReason（不伪装成测过）", async () => {
  const fleets = getFleetDatabase();
  fleets.createFleet({ id: "f-empty", name: "空队", ownerEmail: "alice@x.test" });
  const app = makeApp({ extensionStore: fakeExtensionStore({}) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { fleetId: "f-empty" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.fillsRequired, 0);
  assert.match(r.body.emptyReason, /no pack-backed members/);
});

test("缺 packIds → 400（不是拿空计划冒充计划）", async () => {
  const app = makeApp({ extensionStore: fakeExtensionStore({}) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", { headers: ALICE, body: {} });
  assert.equal(r.status, 400);
});

test("未登录 → 401", async () => {
  const app = makeApp({ extensionStore: fakeExtensionStore({}) });
  const r = await httpRequest(app, "/api/fleets/credential-plan", { body: { packIds: ["x"] } });
  assert.equal(r.status, 401);
});

test("DB 不可用 → 503，不是零填写", async () => {
  const app = makeApp({
    dbOverride: { isDbReady: () => false, getInstalledPack: () => null },
    extensionStore: fakeExtensionStore({}),
  });
  const r = await httpRequest(app, "/api/fleets/credential-plan", {
    headers: ALICE,
    body: { packIds: ["x"] },
  });
  assert.equal(r.status, 503);
});
