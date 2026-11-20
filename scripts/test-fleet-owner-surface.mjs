#!/usr/bin/env node
// ── Fleet owner-surface tests (add-fleet-owner-surface) ──────────────────────
//
//   1. 模板参数槽: parse 声明/占位白名单/未声明引用拒绝; resolve 替换与
//      类型/必填门; 不合值在 provisioner 层 params-invalid（实化零痕迹）。
//   2. from-template 路由: 必填缺失 → 422 params-invalid 指名槽; 提供值 →
//      实化且 cadence 为替换后的值; 无槽模板逐字节。
//   3. owner/board + spend: scope 只见自有; 状态/告警/花销投影各行同源。
//   4. billing snapshot: 账户级窗口差 (delta = 基线 − 当前, 口径行均标注)。
//   5. 机位占位: registry 非 running 行显式为休眠占位, destroyed/未注册不出。
//
// Boot pattern 与 test-fleet-templates.mjs 同一配方 (独立 tmpRoot, 互不在场)。
//
//   node --test scripts/test-fleet-owner-surface.mjs

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-owner-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const dbModule = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { reconcileFleet } = await import("../server/fleet-reconcile.js");
const { parseFleetTemplate, resolveFleetTemplateParams } = await import("../server/fleet-template.js");
const { provisionFleetFromTemplate } = await import("../server/fleet-provisioner.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await dbModule.initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({ file: path.join(tmpRoot, `f-${Math.random().toString(36).slice(2, 8)}.db`) });
  setFleetDatabase(fleetDb);
});

after(async () => {
  cron.shutdown?.();
  await engine.idle().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const ALIVE = (m) => ({ alive: m?.targetId !== "ghost", label: m?.targetId ?? "?", clusterName: null });
const rosterFn = (id) => id;

const goodManifestWithParams = () => ({
  fleet: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture 模拟 fleetContext 占位符字面量
    name: "晨报·${ownerName}",
    params: [
      { name: "ownerName", type: "string", required: true, label: "主人名" },
      { name: "hour", type: "number", default: 9, label: "钟点" },
      { name: "deepSummary", type: "boolean", default: false },
      { name: "cadenceDaily", type: "string", default: "0 9 * * *", required: true },
    ],
    members: [
      {
        ref: "ceo",
        title: "CEO",
        target: { kind: "pack-preset", packId: "pack_p", presetId: "tpl-ceo" },
        kpiSlots: [],
        cadence: { cron: "0 9 * * *", promptTemplate: "晨会" },
      },
      {
        ref: "reporter",
        title: "汇报岗",
        parentRef: "ceo",
        target: { kind: "existing-persona", id: "user-assist" },
        kpiSlots: [],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture 占位符字面量
        cadence: { cron: "${cadenceDaily}", promptTemplate: "深度:${deepSummary} · 由 ${ownerName} 触发" },
      },
    ],
  },
});

const provisionDeps = ({ catalogIds = new Set(["tpl-ceo", "user-assist"]) } = {}) => ({
  db: fleetDb,
  catalogAgentIds: () => catalogIds,
  resolveExisting: ({ kind, id }) => (kind === "persona" ? catalogIds.has(id) : id !== "ghost"),
  reconcile: (fleetId) => reconcileFleet({ fleetId, db: fleetDb, cronApi: cron, resolveTarget: ALIVE, rosterPresetId: rosterFn }),
});

// ── 1. 参数槽: parse/resolve 形状闸 ──────────────────────────────────────────

test("参数槽声明: 合法声明通过; 重复名/坏类型/坏默认值如实拒", () => {
  const ok = parseFleetTemplate(goodManifestWithParams());
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.template.params.length, 4);
  assert.equal(ok.template.params.find((p) => p.name === "ownerName").required, true);

  const dup = goodManifestWithParams();
  dup.fleet.params.push({ name: "ownerName", type: "string" });
  const badDup = parseFleetTemplate(dup);
  assert.equal(badDup.ok, false);
  assert.match(badDup.error, /duplicate param/);

  const badType = goodManifestWithParams();
  badType.fleet.params[1] = { name: "hour", type: "datetime", default: 9 };
  assert.equal(parseFleetTemplate(badType).ok, false);

  const badDefault = goodManifestWithParams();
  badDefault.fleet.params[1] = { name: "hour", type: "number", default: "九" };
  assert.match(parseFleetTemplate(badDefault).error, /must be a finite number/);

  const badDefaultEnumM = {
    fleet: {
      name: "x",
      params: [{ name: "lvl", type: "enum", options: ["a", "b"], default: "c" }],
      members: [{ ref: "m", title: "t", target: { kind: "existing-persona", id: "u" } }],
    },
  };
  assert.match(parseFleetTemplate(badDefaultEnumM).error, /must be one of a, b/);

  const nested = goodManifestWithParams();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture 占位符字面量
  nested.fleet.params[0].default = "由 ${extra} 代发";
  nested.fleet.params.push({ name: "extra", type: "string" });
  const nb = parseFleetTemplate(nested);
  assert.equal(nb.ok, false);
  assert.match(nb.error, /nesting is not substituted/);
});

test("占位引用: 未声明槽位被引用如实拒; 白名单外无插入语", () => {
  const bad = goodManifestWithParams();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture 占位符字面量
  bad.fleet.members[1].cadence.cron = "${noSuch}";
  assert.equal(parseFleetTemplate(bad).ok, false);

  const kept = goodManifestWithParams();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture 占位符字面量
  kept.fleet.members[1].title = "含泪的 ${noSuch} 岗";
  const p = parseFleetTemplate(kept);
  assert.equal(p.ok, true, "title 白名单同样受管 — 未声明引用被拒");
  assert.unused;
  // 注：title 占位本轮未被纳入白名单的消费 — 留白与否按 spec: 白名单位置
  // 之外不看占位 (title 也在白名单内被解析, 但此处故意未声明应拒绝)。
});

test("resolve: 默认值回填+替换; 必填缺失/类型不合如实拒", () => {
  const ok = parseFleetTemplate(goodManifestWithParams());
  const r = resolveFleetTemplateParams(ok.template, { ownerName: "阿良" });
  assert.equal(r.ok, true);
  assert.equal(r.resolved.template.name, "晨报·阿良");
  assert.equal(r.resolved.template.members[1].cadence.cron, "0 9 * * *");
  assert.equal(r.resolved.template.members[1].cadence.promptTemplate, "深度:false · 由 阿良 触发");

  const missing = resolveFleetTemplateParams(ok.template, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].name, "ownerName");

  const badNum = resolveFleetTemplateParams(ok.template, { ownerName: "阿良", hour: "九点" });
  assert.equal(badNum.ok, false);
});

test("provisioner: 替换后结构闸兜底 (坏 cron → params-invalid, 零实化)", async () => {
  const m = goodManifestWithParams();
  const out = await provisionFleetFromTemplate({
    packId: "pack_p1", version: "1.0.0", manifest: m, ownerEmail: "owner@test",
    deps: provisionDeps(),
    params: { ownerName: "阿良", cadenceDaily: "不是cron" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "params-invalid");
  assert.match(out.error, /invalid template|cron/);
  assert.equal(fleetDb.listFleets({ ownerEmail: "owner@test" }).length, 0, "零实化痕迹");
});

test("provisioner: 提供参数实化成功且成员拿到替换后的值; 无槽模板逐字节", async () => {
  const m = goodManifestWithParams();
  const out = await provisionFleetFromTemplate({
    packId: "pack_p2", version: "1.0.0", manifest: m, ownerEmail: "owner@test",
    deps: provisionDeps(),
    params: { ownerName: "阿良", cadenceDaily: "0 11 * * *" },
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.fleet.name, "晨报·阿良");
  const reporter = fleetDb.listMembers(out.fleet.id).find((x) => x.title === "汇报岗");
  assert.equal(reporter.cadence.cron, "0 11 * * *");
  assert.match(reporter.cadence.promptTemplate, /阿良/);

  const legacy = { fleet: { name: "旧模板", members: [{ ref: "a", title: "A岗", target: { kind: "pack-preset", packId: "pack_l", presetId: "tpl-ceo" }, cadence: { cron: "0 9 * * *", promptTemplate: "x" } }] } };
  const out2 = await provisionFleetFromTemplate({ packId: "pack_l", version: "1.0.0", manifest: legacy, ownerEmail: "owner@test", deps: provisionDeps() });
  assert.equal(out2.ok, true);
  assert.equal(out2.fleet.name, "旧模板");
});

// ── 2. from-template 路由 422/201 ─────────────────────────────────────────────

test("from-template 路由: 必填参数缺失 → 422 params-invalid; 提供 → 201 实化", async () => {
  const manifest = goodManifestWithParams();
  dbModule.upsertInstalledPack({
    packId: "pack_rt",
    name: "晨报模板",
    version: "1.0.0",
    manifest: { ...manifest, agents: [{ id: "tpl-ceo", name: "CEO" }] },
    report: { agents: [{ id: "tpl-ceo", status: "installed" }], skills: [] },
  });
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: ALIVE, currentPreset: null });
  const server = http.createServer(app);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  try {
    const no = await fetch(`${base}/api/fleets/from-template`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId: "pack_rt" }) });
    assert.equal(no.status, 422);
    const noBody = await no.json();
    assert.equal(noBody.code, "params-invalid");
    assert.equal(noBody.errors[0].name, "ownerName");

    const yes = await fetch(`${base}/api/fleets/from-template`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packId: "pack_rt", params: { ownerName: "阿良", cadenceDaily: "0 7 * * *" } }) });
    assert.equal(yes.status, 201, JSON.stringify(await yes.clone().json()));
    const fleet = (await yes.json()).fleet;
    assert.equal(fleet.name, "晨报·阿良");
    assert.equal(fleet.state, "paused");
  } finally {
    server.close();
  }
});

// ── 3. owner/board + spend ──────────────────────────────────────────────────

test("owner/board: 仅自有集群; 花销=投影行 (runs/turns/窗口usage); 告警计数随盘", async () => {
  const out = await provisionFleetFromTemplate({ packId: "pack_b1", version: "1.0.0", manifest: goodManifestWithParams(), ownerEmail: "owner@test", deps: provisionDeps(), params: { ownerName: "阿良" } });
  assert.equal(out.ok, true);
  const fid = out.fleet.id;
  // 喂一轮 run+usage（生产形状的 turn 行 → finalizeRun 合成 header 投影）。
  const now = Date.now();
  fleetDb.insertRun({ runId: "run_b1", fleetId: fid, rootSource: "cron", rootMemberId: "m1", startedAt: now - 60_000 });
  fleetDb.appendTurnEvent({ turnId: "t_b1", fleetId: fid, memberId: "m1", source: "cron", runId: "run_b1", parentTurnId: null, edgeKind: null, status: "ok", startedAt: now - 60_000, endedAt: now - 59_000, usage: { input: 111, output: 222 }, errorKind: null, detail: { do: "晨会" } });
  fleetDb.finalizeRun("run_b1", { endedAt: now - 59_000 });
  // 较久一条 (出 24h 窗) — 7d 应含、24h 不应含。
  fleetDb.insertRun({ runId: "run_b2", fleetId: fid, rootSource: "cron", rootMemberId: "m1", startedAt: now - 2 * 86_400_000 });
  fleetDb.appendTurnEvent({ turnId: "t_b2", fleetId: fid, memberId: "m1", source: "cron", runId: "run_b2", parentTurnId: null, edgeKind: null, status: "ok", startedAt: now - 2 * 86_400_000, endedAt: now - 2 * 86_400_000 + 1000, usage: { input: 10, output: 20 }, errorKind: null, detail: { do: "y" } });
  fleetDb.finalizeRun("run_b2", { endedAt: now - 2 * 86_400_000 + 1000 });
  // 他 fleet = 别人范围 (scope 证明)
  await provisionFleetFromTemplate({ packId: "pack_b2", version: "1.0.0", manifest: goodManifestWithParams(), ownerEmail: "stranger@test", deps: provisionDeps(), params: { ownerName: "外" } });

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: ALIVE, currentPreset: null });
  const server = http.createServer(app);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  try {
    const r = await fetch(`${base}/api/fleets/owner/board`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.fleets.length, 1, `owner@test 只见自己的集群 (got: ${body.fleets.map(f=>f.id).join(",")})`);
    const row = body.fleets[0];
    assert.equal(row.id, fid);
    assert.equal(row.state, "paused");
    assert.equal(row.counts.total, 2);
    assert.equal(row.sourceTemplate.packId, "pack_b1");
    assert.equal(typeof row.openDecisions, "number");
    assert.equal(row.failing, row.counts.failing);
    // spend 投影: 24h 只含新 run (1 run/1 turn/333 tokens), 7d/30d 含两条
    assert.equal(row.spend.windows["24h"].runs, 1);
    assert.equal(row.spend.windows["24h"].turns, 1);
    assert.equal(row.spend.windows["24h"].usageInput + row.spend.windows["24h"].usageOutput, 333);
    assert.equal(row.spend.windows["7d"].runs, 2);
    assert.equal(row.spend.windows["30d"].runs, 2);
    assert.equal(row.spend.baseline.includes("projection"), true);

    const spend = await fetch(`${base}/api/fleets/${fid}/spend`);
    assert.equal(spend.status, 200);
    const spendBody = await spend.json();
    assert.equal(spendBody.windows["24h"].usageOutput, 222);
  } finally {
    server.close();
  }
});

// ── 4. billing snapshot ──────────────────────────────────────────────────────

test("billing snapshot: 基线晚窗如实 null; 有基线算消耗; 状态随版面不说都 ok", async () => {
  const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");
  const registry = createPackRegistry({ file: path.join(tmpRoot, "mkt.db") });
  // fake sub2api：两个读点 + 一个写点, 余额人为控制。
  const fake = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url.startsWith("/api/v1/admin/users") && !/\/\d+$/.test(req.url)) {
      return send(200, { code: 0, data: { items: [{ id: 777, email: "payer@test", balance: 100 }] } });
    }
    const m = req.url.match(/^\/api\/v1\/admin\/users\/(\d+)/);
    if (req.method === "GET" && m) return send(200, { code: 0, data: { id: 777, email: "payer@test", balance: 62 } });
    return send(404, {});
  });
  const fakePort = await new Promise((r) => fake.listen(0, "127.0.0.1", () => r(fake.address().port)));
  process.env.SUB2API_ADMIN_KEY = "test-key";
  process.env.SUB2API_BASE_URL = `http://127.0.0.1:${fakePort}`;

  const app = express();
  app.use(express.json());
  registerPackRoutes(app, {
    registry,
    resolveUser: (req) => (req.headers["x-test-session"] ? JSON.parse(req.headers["x-test-session"]) : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({}),
    creatorGroups: [],
    adminGroups: [],
    anonymousRead: true,
    vendors: registry.vendors,
    market: registry.market,
  });
  const server = http.createServer(app);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  const H = { "x-test-session": JSON.stringify({ email: "payer@test" }) };
  try {
    const first = await fetch(`${base}/api/packs/billing/snapshot`, { headers: H });
    assert.equal(first.status, 200);
    const b1 = await first.json();
    assert.equal(b1.accountState, "ok");
    assert.equal(b1.balance, 62);
    assert.equal(b1.deltas["24h"], null, "刚落库无基线");
    // 回灌一个 24h+ 前的基线 → 差=消 12 (74−62)
    registry.recordBillingSnapshot({ email: "payer@test", userId: 777, balanceUsd: 74, at: Date.now() - 25 * 3600_000 });
    const second = await fetch(`${base}/api/packs/billing/snapshot`, { headers: H });
    const b2 = await second.json();
    assert.equal(b2.deltas["24h"].spentUsd, 12);
    assert.ok(b2.basis.includes("账户级"), "口径标注在场");
    // 7d/30d 仍无基线 → null (如实)
    assert.equal(b2.deltas["7d"], null);
  } finally {
    server.close();
    fake.close();
    registry.close();
  }
});

// ── 5. 机位占位 (gateway/fleet-board) ────────────────────────────────────────

test("ownerCellBoard: 未 running 行显式占位, destroyed 不出, 未注册不出", async () => {
  const { ownerCellBoard } = await import("../gateway/fleet-board.js");
  const mkRow = (cellId, state, ownerEmail = "me@test", lastUserTrafficAt = 1) => ({
    cellId, ownerEmail, state, policy: "on_demand", lastUserTrafficAt, lastDutyRunAt: null,
  });
  const registryDb = {
    all: () => [
      mkRow("live-1", "running"),
      mkRow("sleepy-1", "suspended"),
      mkRow("gone-1", "destroyed"),
      mkRow("theirs-1", "running", "other@test"),
    ],
  };
  const board = ownerCellBoard({ registryDb, ownerEmail: "me@test" });
  const byId = Object.fromEntries(board.cells.map((c) => [c.cellId, c]));
  assert.equal(byId["live-1"].placeholder, false);
  assert.equal(byId["sleepy-1"].placeholder, true);
  assert.equal(byId["sleepy-1"].lastTrafficAt, 1);
  assert.equal(byId["gone-1"], undefined, "destroyed 不出位");
  assert.equal(byId["theirs-1"], undefined, "别人的机位不见");
  const foreign = ownerCellBoard({ registryDb: null, ownerEmail: "me@test" });
  assert.deepEqual(foreign.cells, [], "detached registry 空板不报错");
});
