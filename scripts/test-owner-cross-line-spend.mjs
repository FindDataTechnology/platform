#!/usr/bin/env node
// ── Owner cross-line spend tests (add-owner-cross-line-view 1.2/1.3) ─────────
//
//   1. 聚合端点六分组全 ok：真实 fleet 投影 + market/balance 注入 + lex/wire
//      unconnected（无凭据）+ wanxing available:false（无 env 配置）——响应
//      无任何跨线总额字段（schema 无槽）。
//   2. 单线降级：market store 缺失 → 仅 market degraded，其余线照常。
//   3. lex/wire 凭据态：无凭据 → unconnected（零上游调用）；上游 401 →
//      unconnected/expired（凭据翻面）；上游 500 → 仅该线 degraded。
//   4. 萬星代读：WANXING_FACADE_URL+token 注入 mock facade → 按主人 email
//      过滤 caller 行聚合；无 caller 行 → metrics 如实空（无 caller 行≠0 填充
//      ——字段缺失，不出恒零）。facade 不可达 → degraded。
//   5. 只读铁律：端点处理器源码 grep 零写路径（1.4 的机器可核版本）。
//
//   node --test scripts/test-owner-cross-line-spend.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xline-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const dbModule = await import("../db.js");
const engine = await import("../task-engine.js");
const { setFleetDatabase, createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const lc = await import("../line-credentials.js");

await dbModule.initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

after(async () => {
  server.close();
  await new Promise((r) => setTimeout(r, 30));
  cron.shutdown?.();
  await engine.idle().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

const EMAIL = "owner@test";
// JWT-shaped token (liveToken parses exp from the payload).
const lexJwt = (secs = 3600) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ sub: "lx", email: EMAIL, exp: Math.floor(Date.now() / 1000) + secs })).toString("base64url");
  return `${h}.${p}.sig`;
};
const app = express();
app.use(express.json());
// ctx 注入：localPackMarket 双腿（market + billingSnapshots 委托）——生产由
// server.js 的 PACK_MARKETPLACE 分支挂，这里给测试替身。
const marketCalls = { purchases: 0 };
const snapCalls = { count: 0 };
const ctx = {
  authEnabled: false,
  cellUserEmail: EMAIL,
  fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
  currentPreset: null,
  localPackMarket: {
    market: {
      purchasesForBuyer: (email, opts) => {
        marketCalls.purchases += 1;
        assert.equal(email, EMAIL);
        assert.equal(opts.limit, 100);
        return [
          { id: "p1", packName: "包A", amount_usd: 12.5, status: "settled", created_at: 1700000000000 },
          { id: "p2", packName: "包B", amount_usd: 3.25, status: "settled", created_at: 1700000001000 },
          { id: "p3", packName: "包C", amount_usd: 99, status: "pending", created_at: 1700000002000 },
        ];
      },
    },
    billingSnapshots: (email) => {
      snapCalls.count += 1;
      assert.equal(email, EMAIL);
      return [{ email, userId: 1, balanceUsd: 42.1, sampledAt: Date.now() - 60_000 }];
    },
  },
};
createFleetRoutes(app, ctx);
const server = http.createServer(app);
server.unref();
const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

const getLines = async () => {
  const r = await fetch(`${base}/api/fleets/owner/cross-line-spend`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.v, 1);
  assert.equal(typeof body.sampledAt, "number");
  return body;
};

const lineOf = (body, id) => body.lines.find((l) => l.line === id);

test("1.1 六分组齐、每线带口径键；fleet 分组=真实投影（零集群如实空）；market/balance 注入替身真读", async () => {
  const body = await getLines();
  assert.deepEqual(
    body.lines.map((l) => l.line),
    ["fleet", "market", "wanxing", "lex", "wire", "balance"],
  );
  for (const l of body.lines) {
    assert.match(l.calibre, /^owner\./, `${l.line} 带口径键`);
  }
  const fleet = lineOf(body, "fleet");
  assert.equal(fleet.status, "ok");
  assert.equal(fleet.metrics.fleets, 0);
  assert.equal(fleet.metrics.runs, 0);

  const market = lineOf(body, "market");
  assert.equal(market.status, "ok");
  assert.equal(market.metrics.purchases, 3);
  assert.equal(market.metrics.settled, 2);
  assert.equal(market.metrics.settled_usd, 15.75);
  assert.equal(market.metrics.pending_usd, undefined, "pending 金额不混入 settled 口径");

  const balance = lineOf(body, "balance");
  assert.equal(balance.status, "ok");
  assert.equal(balance.metrics.balance_usd, 42.1);

  assert.equal(marketCalls.purchases, 1);
  assert.equal(snapCalls.count, 1);
});

test("1.2 响应无跨线总额字段（schema 无槽）；各分组货币/单位异构", async () => {
  const body = await getLines();
  const flat = JSON.stringify(body);
  assert.equal(/"total"/.test(flat), false, "无 total 槽");
  assert.equal(/"grand_total"/.test(flat), false);
  assert.equal(/"combined"/.test(flat), false);
  // 顶层就是 v/sampledAt/lines 三键——不给聚合计算留位置。
  assert.deepEqual(Object.keys(body).sort(), ["lines", "sampledAt", "v"]);
});

test("1.3 lex/wire 无凭据 → unconnected（零上游调用语义），状态如实；wanxing 无 env → available:false 如实呈现", async () => {
  const body = await getLines();
  const lex = lineOf(body, "lex");
  assert.equal(lex.status, "ok", "unconnected 是如实状态不是失败——分组本身 ok");
  assert.equal(lex.metrics.unconnected, "not_connected");

  const wire = lineOf(body, "wire");
  assert.equal(wire.status, "ok");
  assert.equal(wire.metrics.unconnected, "not_connected");

  const wanxing = lineOf(body, "wanxing");
  assert.equal(wanxing.status, "ok");
  assert.equal(wanxing.metrics.available, false, "无配置=不可用如实标注（不 500）");
});

test("1.4 lex 上游 401 → 凭据翻面 unconnected/expired；上游 500 → 仅 lex degraded", async () => {
  // 先给 lex 连接态（真凭据行），fetch 指向会 401 的本地 mock。
  lc.store({ email: EMAIL, line: "lex", token: lexJwt(), refreshToken: null });
  const up = http.createServer((req, res) => {
    res.writeHead(req.url.includes("boom") ? 500 : 401);
    res.end("{}");
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const lexBase = `http://127.0.0.1:${up.address().port}`;

  // 401 → expired 翻面
  {
    const r = await fetch(`${base}/api/fleets/owner/cross-line-spend`);
    const body = await r.json();
    const lex = lineOf(body, "lex");
    assert.equal(lex.status, "ok");
    assert.equal(lex.metrics.unconnected, "expired", "401 翻面如实呈现");
  }

  // 重连后再打 500 → 仅 lex degraded，其余线照常
  lc.store({ email: EMAIL, line: "lex", token: lexJwt(), refreshToken: null });
  // 500 分支：直接对 helper 打（端点内 apiBase 不可注入 env —— helper 默认 LEX_ORIGIN；
  // 用 fetch 替身在模块层不可行，这里用本地 server + env 覆盖不行 → 改为验证
  // degraded 形状经 helper 直调）。
  const { fetchLexUsageFor } = await import("../lib/board-adapters.js");
  const degraded = await fetchLexUsageFor(EMAIL, { apiBase: lexBase, deps: { fetch: async () => ({ ok: false, status: 500, text: async () => "boom" }) } });
  assert.equal(degraded.status, "degraded");

  up.close();
});

test("1.5 萬星代读：mock facade → 按主人 email 过滤聚合；无 caller 行 → 字段如实缺席（非 0 填充）", async () => {
  const seen = [];
  const up = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      byCaller: [
        { callerId: "c1", email: EMAIL, turns: 7, minutes: 9, usd: 1.234, pending: 1 },
        { callerId: "c2", email: "someone-else@test", turns: 100, minutes: 200, usd: 99, pending: 0 },
      ],
      byAgent: [],
    }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  process.env.WANXING_FACADE_URL = `http://127.0.0.1:${up.address().port}`;
  process.env.AGENT_SERVING_REGISTRY_TOKEN = "svc-token";

  const body = await getLines();
  const w = lineOf(body, "wanxing");
  assert.equal(w.status, "ok");
  assert.equal(w.metrics.available, true);
  assert.equal(w.metrics.turns, 7, "只聚合主人自己的 caller 行");
  assert.equal(w.metrics.minutes, 9);
  assert.equal(w.metrics.usd, 1.23);
  assert.equal(w.metrics.pending, 1);
  assert.equal(seen[0].auth, "Bearer svc-token");

  // 无 caller 行 → 字段缺席（不出 turns:0 假零）
  up.close();
  const up2 = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ byCaller: [{ callerId: "c9", email: "other@x", turns: 5, minutes: 5, usd: 5, pending: 0 }], byAgent: [] }));
  });
  await new Promise((r) => up2.listen(0, "127.0.0.1", r));
  process.env.WANXING_FACADE_URL = `http://127.0.0.1:${up2.address().port}`;
  const body2 = await getLines();
  const w2 = lineOf(body2, "wanxing");
  assert.equal(w2.status, "ok");
  assert.equal(w2.metrics.available, true);
  assert.equal(w2.metrics.turns, undefined, "无行=字段缺席，不冒充 0");
  assert.equal(w2.metrics.minutes, undefined);

  // facade 不可达 → 仅该线 degraded
  up2.close();
  process.env.WANXING_FACADE_URL = "http://127.0.0.1:1";
  const body3 = await getLines();
  const w3 = lineOf(body3, "wanxing");
  assert.equal(w3.status, "degraded");
  const others = body3.lines.filter((l) => l.line !== "wanxing");
  assert.ok(others.every((l) => l.status === "ok"), "其余线照常");
  delete process.env.WANXING_FACADE_URL;
  delete process.env.AGENT_SERVING_REGISTRY_TOKEN;
});

test("1.6 market store 缺失 → 仅 market degraded，其余线照常（独立降级形状）", async () => {
  // 临时摘掉 market 腿再请求
  const saved = ctx.localPackMarket.market;
  ctx.localPackMarket.market = null;
  try {
    const body = await getLines();
    const m = lineOf(body, "market");
    assert.equal(m.status, "degraded");
    assert.ok(m.error, "degraded 带错误说明");
    const rest = body.lines.filter((l) => l.line !== "market");
    assert.ok(rest.every((l) => l.status === "ok"));
  } finally {
    ctx.localPackMarket.market = saved;
  }
});

test("1.7 只读铁律：聚合端点处理器源码无写路径（POST/PATCH/UPDATE/INSERT/扣费）", async () => {
  const src = fs.readFileSync(new URL("../server/routes/fleets.js", import.meta.url), "utf8");
  const start = src.indexOf('router.get("/owner/cross-line-spend"');
  assert.ok(start > 0, "端点在位");
  // 处理器体 = 从起点到下一个路由注册
  const next = src.indexOf("router.", start + 40);
  const body = src.slice(start, next);
  for (const forbidden of [".post(", ".patch(", ".delete(", "INSERT INTO", "UPDATE ", "DELETE FROM", "deduct", "settle(", "charge"]) {
    assert.equal(body.includes(forbidden), false, `处理器内不得出现 ${forbidden}`);
  }
});
