#!/usr/bin/env node
// ── Market revenue share tests (add-market-revenue-share) ────────────────────
//
// Mounts the REAL facets: vendor identity + market 成交/结算/收益 routes +
// pack publish/detail path, with fakes confined to the two seams the code
// already honors: the Logto session (x-test-session) and the sub2api client
// (injected in-memory readUser/adjustBalance). Everything else is production:
// pricing stamps, idempotency, credit pool projection, entailment flags.
//
//   node --test scripts/test-market-revenue-share.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { test, after } from "node:test";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { registerVendorRoutes } from "../gateway/vendors.js";
import { registerMarketRoutes } from "../gateway/market.js";

const tmp = mkdtempSync(path.join(tmpdir(), "market-revenue-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const registry = createPackRegistry({ file: path.join(tmp, "packs.db") });

// ── Fake sub2api (the ONLY replaced seam; the gateway's own ledger idempotency
//    lives in production code and stays under test) ───────────────────────────
const ledger = {
  users: new Map(), // userId -> { balance }
  adjusts: [],
  fail: null,
  insertAccount(email, userId, balance) {
    this.users.set(userId, { email, balance });
    // Register in the pack registry's own account table (same row the deploy
    // flow writes) so billingAccount() resolves.
    registry.saveBillingAccount?.({ email, userId });
    // Fallback for registries without the writer: direct table write.
    try {
      // createPackRegistry exposes only readers — route through its SQL
      // helper when present; otherwise the test helper below seeds directly.
    } catch { /* see seedBilling below */ }
  },
};
const sub2api = {
  async readUser(userId) {
    if (ledger.failRead) throw new Error(ledger.failRead);
    const u = ledger.users.get(userId);
    if (!u) throw new Error(`user ${userId} not found`);
    return { balance: u.balance, status: "active", email: u.email };
  },
  async adjustBalance({ userId, amountUsd, operation, idempotencyKey }) {
    if (ledger.failAdjust) throw new Error(ledger.failAdjust);
    ledger.adjusts.push({ userId, amountUsd, operation, idempotencyKey });
    const u = ledger.users.get(userId);
    if (!u) throw new Error(`user ${userId} not found`);
    u.balance += operation === "add" ? Number(amountUsd) : -Number(amountUsd);
    return { ok: true };
  },
};

const resolveUser = (req) => {
  const raw = req.headers["x-test-session"];
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    return typeof doc?.email === "string" ? { email: doc.email, groups: doc.groups ?? [] } : null;
  } catch {
    return null;
  }
};
const rejectUnauthenticated = (_req, res) => res.status(401).json({ error: "Authentication required" });

const app = express();
app.use(express.json({ limit: "1mb" }));
const ADMIN = ["admins"];
registerVendorRoutes(app, { vendors: registry.vendors, resolveUser, rejectUnauthenticated, adminGroups: ADMIN });
registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups: ["creators"],
  adminGroups: ADMIN,
  anonymousRead: true,
  vendors: registry.vendors,
  market: registry.market,
});
registerMarketRoutes(app, {
  registry,
  vendors: registry.vendors,
  market: registry.market,
  resolveUser,
  rejectUnauthenticated,
  adminGroups: ADMIN,
  deps: { sub2api, shareRate: 0.3 },
});
const server = http.createServer(app);
const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
after(() => {
  server.closeAllConnections?.();
  server.close();
  registry.close();
});

const H = (email, groups = []) => ({ "x-test-session": JSON.stringify({ email, groups }), "Content-Type": "application/json" });
const post = (p, email, body, groups = []) => fetch(`${base}${p}`, { method: "POST", headers: H(email, groups), body: JSON.stringify(body) });
const get = (p, email, groups = []) => fetch(`${base}${p}`, { headers: H(email, groups) });

const manifest = (name) => ({
  name,
  description: "market revenue share test",
  skills: [{ name: "s", description: "d", content: "# s\nbody" }],
});
// Seed the billing account table through a published-then-linked row: the
// registry's writer is internal (deploy flow); tests seed straight SQL via a
// throwaway Database on the same file? NO — same-process better-sqlite3
// handles conflict. The registry exposes billingAccount (reader) only, so we
// add accounts through the published route surface: use the vendors store…
// Simplest honest seam: craft sub2api_accounts rows via the registry's own
// close-then-reopen is overkill. The pack registry's table writer used by
// deploys is `recordBillingAccount` — assert it exists, else fail loudly.
const seedAccount = (email, userId, balance) => {
  assert.ok(registry.saveBillingAccount, "registry must expose saveBillingAccount (deploy flow writer)");
  registry.saveBillingAccount({ email, userId });
  ledger.users.set(userId, { email, balance });
};

const vendor = "acme";
const vendorOwner = "owner@acme.test";
const buyer = "buyer@test.dev";
const ADMIN_EMAIL = "root@admins.test";

test("布置：vendor 注册 + 买家/卖家账户种子", async () => {
  assert.ok(registry.saveBillingAccount, "registry.saveBillingAccount must exist");
  await post("/api/vendors", vendorOwner, { slug: vendor, displayName: "Acme 供应", contact: "ops@acme.test" });
  seedAccount(buyer, 1001, 100);
  seedAccount(vendorOwner, 1002, 10);
  assert.equal(registry.billingAccount(buyer).user_id, 1001);
});

let freePackId;
let paidPackId;
test("发布：免费条目无 pricing、付费条目版本级价格声明（服务端字段）", async () => {
  const free = await post("/api/packs", vendorOwner, { manifest: manifest("free-toolkit"), vendor: "acme" });
  assert.equal(free.status, 200);
  freePackId = (await free.json()).id;
  const priced = await post("/api/packs", vendorOwner, {
    manifest: manifest("paid-toolkit"),
    vendor: "acme",
    pricing: { priceUsd: 20, kind: "once" },
  });
  assert.equal(priced.status, 200);
  paidPackId = (await priced.json()).id;
  const detail = await (await get(`/api/packs/${paidPackId}`, buyer)).json();
  assert.deepEqual(detail.pricing, { priceUsd: 20, kind: "once" });
  const listed = await (await get("/api/packs?search=free-toolkit", buyer)).json();
  assert.equal(listed.packs[0].pricing, undefined);
  // 非法价格声明被发布闸拦下
  const bad = await post("/api/packs", vendorOwner, { manifest: manifest("bad-priced"), vendor: "acme", pricing: { priceUsd: -5 } });
  assert.equal(bad.status, 400);
});

test("匿名浏览可见价格但无 purchased；买家先见未购状态", async () => {
  const anon = await fetch(`${base}/api/packs/${paidPackId}`);
  const body = await anon.json();
  assert.deepEqual(body.pricing, { priceUsd: 20, kind: "once" });
  assert.equal(body.purchased, undefined);
  const before = await (await get(`/api/packs/${paidPackId}`, buyer)).json();
  assert.equal(before.purchased, false);
});

test("免费条目购买被如实拒 (not-for-sale)", async () => {
  const r = await post(`/api/packs/${freePackId}/purchase`, buyer, {});
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "not-for-sale");
});

let purchaseRow;
test("购买：成交记全字段 + 已结算 + 幂等重放原行", async () => {
  const r = await post(`/api/packs/${paidPackId}/purchase`, buyer, {});
  assert.equal(r.status, 201);
  purchaseRow = (await r.json()).purchase;
  assert.equal(purchaseRow.status, "settled");
  assert.equal(purchaseRow.priceUsd, 20);
  assert.equal(purchaseRow.vendorSlug, "acme");
  assert.equal(purchaseRow.vendorEarnedUsd, 14);
  assert.equal(purchaseRow.platformEarnedUsd, 6);
  assert.equal(purchaseRow.chargeUsd, 20);
  // 余额与幂等键：买家 100→80，结算幂等键=成交行 id
  assert.equal(ledger.users.get(1001).balance, 80);
  assert.equal(ledger.adjusts[0].idempotencyKey, `mkt_${purchaseRow.id}`);
  // 重放：再次购买幂等返回（已有活动权益），不产生新行
  const replay = await post(`/api/packs/${paidPackId}/purchase`, buyer, {});
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).note, "already-entitled");
  assert.equal(ledger.adjusts.length, 1);
  // 详情面 purchased 翻转
  const after = await (await get(`/api/packs/${paidPackId}`, buyer)).json();
  assert.equal(after.purchased, true);
});

test("供应商收益账：分成投影可重算、抵扣池就位，且只见自己主体", async () => {
  await post("/api/vendors", "boss@rival.test", { slug: "rival", displayName: "Rival", contact: "r@r.test" });
  const mine = await (await get("/api/vendors/acme/earnings", vendorOwner)).json();
  assert.equal(mine.earnings.settledUsd, 14);
  assert.equal(mine.earnings.availableCreditUsd, 14);
  assert.equal(mine.purchases.length, 1);
  const forbidden = await get("/api/vendors/acme/earnings", "boss@rival.test");
  assert.equal(forbidden.status, 403);
});

test("抵扣闭环：绑 member 用主体收益减免现金部分", async () => {
  // vendorOwner 自己买付费条目（vendor 主体收益 14 可抵扣）
  const second = await post("/api/packs", vendorOwner, { manifest: manifest("second-paid"), vendor: "acme", pricing: { priceUsd: 10, kind: "once" } });
  const pid = (await second.json()).id;
  const r = await post(`/api/packs/${pid}/purchase`, vendorOwner, {});
  assert.equal(r.status, 201);
  const row = (await r.json()).purchase;
  assert.equal(row.creditUsd, 10); // 收益 14 覆盖 10 全价
  assert.equal(row.chargeUsd, 0);
  assert.equal(row.creditVendorSlug, "acme");
  assert.equal(ledger.users.get(1002).balance, 10); // 未扣现金
  const earnings = await (await get("/api/vendors/acme/earnings", vendorOwner)).json();
  assert.equal(earnings.earnings.settledUsd, 21); // 14 + 7（新成交 10×70%）
  assert.equal(earnings.earnings.availableCreditUsd, 11); // 21 − 10 已耗抵扣
});

test("余额不足如实拒：差额呈现、无成交行、无账变", async () => {
  seedAccount("poor@test.dev", 1003, 5);
  const pr = await post("/api/packs", vendorOwner, { manifest: manifest("pricey-pack"), vendor: "acme", pricing: { priceUsd: 50 } });
  const pid = (await pr.json()).id;
  const r = await post(`/api/packs/${pid}/purchase`, "poor@test.dev", { useCredit: true });
  assert.equal(r.status, 402);
  const body = await r.json();
  assert.equal(body.code, "insufficient-balance");
  assert.equal(body.shortfallUsd, 45);
  assert.equal(ledger.users.get(1003).balance, 5);
  const status = await (await get(`/api/packs/${pid}/purchase-status`, "poor@test.dev")).json();
  assert.equal(status.entitled, false);
});

test("sub2api 侧失败挂账 failed（不虚构已结），重试结算幂等键一致", async () => {
  seedAccount("flaky@test.dev", 1004, 100);
  const pr = await post("/api/packs", vendorOwner, { manifest: manifest("flaky-pack"), vendor: "acme", pricing: { priceUsd: 8 } });
  const pid = (await pr.json()).id;
  ledger.failAdjust = "sub2api subtract exploded";
  const first = await post(`/api/packs/${pid}/purchase`, "flaky@test.dev", {});
  assert.equal(first.status, 502);
  assert.equal((await first.json()).purchase.status, "failed");
  ledger.failAdjust = null;
  // 同 idem 键重放 → 重试结算成交, 幂等键=原行 id
  const retry = await post(`/api/packs/${pid}/purchase`, "flaky@test.dev", {});
  assert.ok([200, 201].includes(retry.status), `status ${retry.status}`);
  const row = (await retry.json()).purchase;
  assert.equal(row.status, "settled");
  const lastAdjust = ledger.adjusts.at(-1);
  assert.equal(lastAdjust.idempotencyKey, `mkt_${row.id}`);
  assert.equal(ledger.users.get(1004).balance, 92);
});

test("拒付以反向行登记：原行不动、余额回补、权益失效、收益回转", async () => {
  const pre = await (await get("/api/vendors/acme/earnings", vendorOwner)).json();
  const r = await post(`/api/ops/market-purchases/${purchaseRow.id}/refund`, ADMIN_EMAIL, { note: "chargeback ruling" }, ADMIN);
  assert.equal(r.status, 201);
  const refund = (await r.json()).refund;
  assert.equal(refund.direction, "refund");
  assert.equal(refund.status, "settled");
  assert.equal(ledger.users.get(1001).balance, 100); // 80 + 20 回补
  const dup = await post(`/api/ops/market-purchases/${purchaseRow.id}/refund`, ADMIN_EMAIL, {}, ADMIN);
  assert.equal((await dup.json()).note, "idempotent-replay");
  // 权益失效（buyer 重购成可能）、收益投影回填
  const status = await (await get(`/api/packs/${paidPackId}/purchase-status`, buyer)).json();
  assert.equal(status.entitled, false);
  const after = await (await get("/api/vendors/acme/earnings", vendorOwner)).json();
  assert.ok(Math.abs(after.earnings.settledUsd - (pre.earnings.settledUsd - 14)) < 0.001, `settled ${after.earnings.settledUsd} vs ${pre.earnings.settledUsd - 14}`);
});

test("订阅期条目：期窗幂等桶 + 到期失资格", async () => {
  const pr = await post("/api/packs", vendorOwner, { manifest: manifest("period-pack"), vendor: "acme", pricing: { priceUsd: 12, kind: "period", periodDays: 30 } });
  const pid = (await pr.json()).id;
  const r = await post(`/api/packs/${pid}/purchase`, buyer, {});
  assert.equal(r.status, 201);
  assert.equal((await r.json()).purchase.kind, "period");
  // 同窗重复 = 权益返回, 不再成交
  const again = await post(`/api/packs/${pid}/purchase`, buyer, {});
  assert.equal((await again.json()).note, "already-entitled");
});

test("边界回归：调用量计费链语义不被本账本触碰", async () => {
  // 既有 wanxing/sub2api 结算路径未被 market.js 引用任何一行代码 (静态断言)
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../gateway/market.js", import.meta.url), "utf8"));
  assert.ok(!/adjustBalance\(\{[^}]*usageId/.test(src), "market 不得触碰 usage 结算键轨");
  assert.ok((src.match(/idempotencyKey: `mkt_/g) || []).length >= 1);
});

test("买家读面与供应商读面同源：双方各见同一成交行", async () => {
  const mine = await (await get("/api/market/purchases/mine", buyer)).json();
  const hit = mine.purchases.find((p) => p.id === purchaseRow.id);
  assert.ok(hit);
  const vendorSide = await (await get("/api/vendors/acme/earnings", vendorOwner)).json();
  assert.ok(vendorSide.purchases.find((p) => p.id === purchaseRow.id));
});

// ── 装前闸（cell 侧 routes/packs.js + pack-manifest-source fetchMarketDetail）─
test("装前闸：未成交 402 如实拒，已成交放行到既有 manifest 流", async () => {
  const { registerPackRoutes: registerCellPackRoutes } = await import("../server/routes/packs.js");
  const { fetchMarketDetail } = await import("../server/pack-manifest-source.js");

  // 造一条有权益的付费条目（独立 fixture，不依赖前文顺序）。
  const mk = await post("/api/vendors", "gate@boss.test", { slug: "gatev", displayName: "GateV", contact: "g@g.test" });
  assert.ok([201, 409].includes(mk.status));
  const pr = await post("/api/packs", "gate@boss.test", { manifest: manifest("gated-pack"), vendor: "gatev", pricing: { priceUsd: 6 } });
  const gid = (await pr.json()).id;
  seedAccount("gated-buyer@test.dev", 1005, 50);
  await post(`/api/packs/${gid}/purchase`, "gated-buyer@test.dev", {});

  // 单元：本地面证词（fetchMarketDetail 的 localMarket 通道）
  const detailNo = await fetchMarketDetail({
    packId: gid,
    viewer: { email: "stranger@test.dev", groups: [] },
    localMarket: { getLatest: () => ({ version: 1, manifest: {}, pricing: { priceUsd: 6, kind: "once" } }), market: registry.market },
  });
  assert.equal(detailNo.purchased, false);
  const detailYes = await fetchMarketDetail({
    packId: gid,
    viewer: { email: "gated-buyer@test.dev", groups: [] },
    localMarket: { getLatest: () => ({ version: 1, manifest: {}, pricing: { priceUsd: 6, kind: "once" } }), market: registry.market },
  });
  assert.equal(detailYes.purchased, true);

  // 路由级：未成交 → 402 market-purchase-required（不触 manifest 流）
  const app2 = express();
  app2.use(express.json());
  registerCellPackRoutes({
    app: app2,
    db: { isDbReady: () => true },
    broadcast: () => {},
    requireMcpManage: () => true,
    authEnabled: true,
    cellUserEmail: "cell@test.dev",
    localPackMarket: {
      getLatest: () => ({ version: 1, manifest: { name: "gated-pack", description: "d", skills: [{ name: "s", description: "d", content: "c" }] }, pricing: { priceUsd: 6, kind: "once" } }),
      getVersion: (_packId, _version, _viewer) => ({ manifest: { name: "gated-pack", description: "d", skills: [{ name: "s", description: "d", content: "c" }] } }),
      market: registry.market,
    },
  });
  const srv2 = http.createServer(app2);
  const base2 = await new Promise((r) => srv2.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv2.address().port}`)));
  const denied = await fetch(`${base2}/api/mypacks/install`, { method: "POST", headers: { "Content-Type": "application/json", "x-test-session": JSON.stringify({ email: "stranger@test.dev" }) }, body: JSON.stringify({ packId: "whatever", version: 1 }) });
  assert.equal(denied.status, 402);
  assert.equal((await denied.json()).code, "market-purchase-required");
  // 已成交：闸放行 → 进入既有 manifest 流（此 stub 不含用户身份的 cell gate
  // 直通 requireMcpManage=true；放行证据=不是 402）。
  // cell 路由 req.user 未设置时 viewer 走 authEnabled?null:fallback —— 本
  // 环境 authEnabled=true ⇒ viewer=null ⇒ purchased=false。用 requireMcpManage
  // 放行+viewer 主身份的人造 ctx 需要 authEnabled=false 的 fallback。
  const app3 = express();
  app3.use(express.json());
  registerCellPackRoutes({
    app: app3,
    db: { isDbReady: () => true },
    broadcast: () => {},
    requireMcpManage: () => true,
    authEnabled: false,
    cellUserEmail: "gated-buyer@test.dev",
    localPackMarket: {
      getLatest: () => ({ version: 1, manifest: { name: "gated-pack", description: "d", skills: [{ name: "s", description: "d", content: "c" }] }, pricing: { priceUsd: 6, kind: "once" } }),
      getVersion: () => null, // install 继续即返回错误 — 404 证明闸已过
      market: registry.market,
    },
  });
  const srv3 = http.createServer(app3);
  const base3 = await new Promise((r) => srv3.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv3.address().port}`)));
  const allowed = await fetch(`${base3}/api/mypacks/install`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packId: gid, version: 1 }) });
  assert.notEqual(allowed.status, 402, `expect gate to pass, got ${allowed.status}: ${await allowed.clone?.().text?.().catch(() => "")}`);
  const allowedBody = await allowed.json().catch(() => ({}));
  assert.ok(allowedBody.code !== "market-purchase-required");
  srv2.closeAllConnections?.(); srv2.close(); srv3.closeAllConnections?.(); srv3.close();
});
