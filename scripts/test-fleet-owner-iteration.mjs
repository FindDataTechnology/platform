#!/usr/bin/env node
// ── Fleet owner-iteration tests (add-fleet-owner-iteration) ──────────────────
//
//   1. 提议入队: 拍板型拍板项 + 迭代行 state=proposed; 空负载如实拒。
//   2. 批准回调 (路由级): decision approved + iteration 铸版到 published,
//      发布载荷=导出模板+原 manifest 合并; 失败记轴, 结论不翻盘。
//   3. 失败轴与重试: validate 先拒 → failed(validate); 修复后 retry → published;
//      published 的 retry = 幂等。
//   4. 订阅跟新读面: v1→v2 后 updates 行携 notes; 未订阅主体不出现。
//   5. digest: 订阅→渲染决定性内容(岗名/未报/拍板数/token行)→会话记录 + 窗口克制 +
//      退订即止。
//
//   node --test scripts/test-fleet-owner-iteration.mjs

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-iter-"));
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
const { provisionFleetFromTemplate } = await import("../server/fleet-provisioner.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const { createConfigChangeProposal, runIterationCast, retryIterationCast } = await import("../server/fleet-iteration.js");
const { renderDigest, determineDueSubscriptions, runDueDigests } = await import("../server/fleet-digest.js");

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
const manifestOf = () => ({
  name: "晨报模板",
  description: "d",
  fleet: {
    name: "晨报组",
    members: [
      { ref: "ceo", title: "CEO", target: { kind: "pack-preset", packId: "pack_i", presetId: "tpl-ceo" }, kpiSlots: [{ key: "kpi1", label: "产出" }], cadence: { cron: "0 9 * * *", promptTemplate: "晨会" } },
      { ref: "reporter", title: "汇报岗", parentRef: "ceo", target: { kind: "existing-persona", id: "user-assist" }, kpiSlots: [], cadence: { cron: "0 9 * * *", promptTemplate: "日报" } },
    ],
  },
});
const provisionDeps = () => ({
  db: fleetDb,
  catalogAgentIds: () => new Set(["tpl-ceo", "user-assist"]),
  resolveExisting: ({ kind, id }) => (kind === "persona" ? ["tpl-ceo", "user-assist"].includes(id) : true),
  reconcile: (fleetId) => reconcileFleet({ fleetId, db: fleetDb, cronApi: cron, resolveTarget: ALIVE, rosterPresetId: rosterFn }),
});

async function makeFleet(ownerEmail = "owner@test") {
  const out = await provisionFleetFromTemplate({ packId: "pack_i", version: "1.0.0", manifest: manifestOf(), ownerEmail, deps: provisionDeps() });
  assert.equal(out.ok, true, out.error);
  dbModule.upsertInstalledPack({
    packId: "pack_i",
    name: "晨报模板",
    version: "1.0.0",
    manifest: { ...manifestOf(), agents: [{ id: "tpl-ceo", name: "CEO" }] },
    report: { agents: [{ id: "tpl-ceo", status: "installed" }], skills: [] },
  });
  return out.fleet;
}

// ── 1. 提议入队 ──────────────────────────────────────────────────────────────

test("提议入队: config-change 型拍板+iteration proposed; 空负载如实拒", async () => {
  const fleet = await makeFleet();
  const out = createConfigChangeProposal({
    db: fleetDb,
    fleet,
    ownerEmail: "owner@test",
    changeDoc: { summary: "晨会提早一小时", changes: { cadenceDaily: "0 8 * * *" }, diff: { cron: "0 9→8" } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.decision.itemType, "config-change");
  assert.equal(out.decision.state, "open");
  assert.equal(out.decision.detail.summary, "晨会提早一小时");
  assert.equal(out.iteration.state, "proposed");
  assert.equal(out.iteration.decisionId, out.decision.id);
  // 批准前零生效: fleet 成员不变
  const members = fleetDb.listMembers(fleet.id);
  assert.equal(members.some((m) => m.cadence?.cron === "0 8 * * *"), false);

  const bad1 = createConfigChangeProposal({ db: fleetDb, fleet, ownerEmail: "owner@test", changeDoc: { changes: { a: 1 } } });
  assert.equal(bad1.ok, false);
  const bad2 = createConfigChangeProposal({ db: fleetDb, fleet, ownerEmail: "owner@test", changeDoc: { summary: "s", changes: {} } });
  assert.equal(bad2.ok, false);
});

// ── 2. 批准回调 (路由级) ─────────────────────────────────────────────────────

test("批准回调: decision approved + iteration published; manifest 携导出模板段+原字段", async () => {
  const fleet = await makeFleet();
  const app = express();
  app.use(express.json());
  const published = [];
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: ALIVE,
    currentPreset: null,
    iterationsInstallFn: () => dbModule.getInstalledPack("pack_i"),
    iterationsPublisher: async ({ packId, manifest }) => {
      published.push({ packId, manifest });
      return { id: packId, version: 2 };
    },
    iterationsValidator: async () => ({ valid: true, errors: [] }),
  });
  const server = http.createServer(app);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  try {
    const prop = await fetch(`${base}/api/fleets/${fleet.id}/iterations/propose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "晨会提前", changes: { cadenceDaily: "0 8 * * *" } }),
    }).then((r) => r.json());
    assert.equal(prop.decision.itemType, "config-change");
    const approve = await fetch(`${base}/api/fleets/${fleet.id}/decisions/${prop.decision.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice: "approve" }),
    });
    assert.equal(approve.status, 200);
    const body = await approve.json();
    assert.equal(body.decision.state, "approved");
    assert.equal(body.iteration.state, "published");
    assert.equal(body.iteration.publishedVersion, 2);
    // 发布载荷: 原 manifest 除 fleet 段被导出值替换
    assert.equal(published.length, 1);
    assert.equal(published[0].manifest.name, "晨报模板");
    assert.equal(published[0].manifest.fleet.members.length, 2);
    assert.equal(published[0].manifest.fleet.members[0].target.kind, "existing-persona");
    assert.equal(published[0].manifest.fleet.orchestration, undefined, "未声明编排段的模板不带");
    assert.equal(published[0].manifest.notes, "晨会提前");
  } finally {
    server.close();
  }
});

test("回调失败不翻盘: publish 失败 → iteration failed(axis=publish), decision 仍 approved", async () => {
  const fleet = await makeFleet();
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: ALIVE,
    currentPreset: null,
    iterationsPublisher: async () => ({ error: "market blast rejected" }),
    iterationsValidator: async () => ({ valid: true, errors: [] }),
  });
  const server = http.createServer(app);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  try {
    const prop = await createConfigChangeProposal({ db: fleetDb, fleet, ownerEmail: "owner@test", changeDoc: { summary: "x", changes: { a: 1 } } });
    const approve = await fetch(`${base}/api/fleets/${fleet.id}/decisions/${prop.decision.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice: "approve" }),
    });
    const body = await approve.json();
    assert.equal(approve.status, 200);
    assert.equal(body.decision.state, "approved");
    assert.equal(body.iteration.state, "failed");
    assert.equal(body.iteration.axis, "publish");
    assert.match(body.iteration.note, /blast/);
  } finally {
    server.close();
  }
});

// ── 3. 失败轴与重试 ──────────────────────────────────────────────────────────

test("失败轴 validate 留痕 + 修复后从失败环重试; published 幂等", async () => {
  const fleet = await makeFleet();
  const prop = createConfigChangeProposal({ db: fleetDb, fleet, ownerEmail: "owner@test", changeDoc: { summary: "x", changes: { a: 1 } } });
  const pubCalls = [];
  let badFirst = true;
  const validateFn = async () => (badFirst ? { valid: false, errors: [{ error: "manifest invalid sections" }] } : { valid: true, errors: [] });
  const publishFn = async ({ packId, manifest }) => {
    pubCalls.push({ packId, manifest });
    return { id: packId, version: 3 };
  };
  const installFn = () => dbModule.getInstalledPack("pack_i");

  const iteration = await runIterationCast({ db: fleetDb, iteration: prop.iteration, ownerEmail: "owner@test", installFn, publishFn, validateFn, log: { warn() {} } });
  assert.equal(iteration.state, "failed");
  assert.equal(iteration.axis, "validate");
  assert.equal(pubCalls.length, 0, "预检不过不碰发布预算");

  badFirst = false;
  const retry = await retryIterationCast({ db: fleetDb, iterationId: prop.iteration.id, ownerEmail: "owner@test", installFn, publishFn, validateFn, log: { warn() {} } });
  assert.equal(retry.iteration.state, "published");
  assert.equal(pubCalls.length, 1);

  const again = await retryIterationCast({ db: fleetDb, iterationId: prop.iteration.id, ownerEmail: "owner@test", installFn, publishFn, validateFn, log: { warn() {} } });
  assert.equal(again.already, true);
  assert.equal(pubCalls.length, 1, "published 幂等不重发");

  const proposed = await retryIterationCast({ db: fleetDb, iterationId: (() => { const p = createConfigChangeProposal({ db: fleetDb, fleet, ownerEmail: "owner@test", changeDoc: { summary: "z", changes: { b: 2 } } }); return p.iteration.id; })(), ownerEmail: "owner@test", installFn, publishFn, validateFn, log: { warn() {} } });
  assert.equal(proposed.ok, false);
});

// ── 4. 订阅跟新读面 ──────────────────────────────────────────────────────────

test("subscriptions/updates: 新版本来了出现带 notes 的行; 未订阅主体不出现", async () => {
  const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");
  const registry = createPackRegistry({ file: path.join(tmpRoot, "mkt-r.db") });
  const app = express();
  app.use(express.json());
  registerPackRoutes(app, {
    registry,
    resolveUser: (req) => (req.headers["x-test-session"] ? JSON.parse(req.headers["x-test-session"]) : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({}),
    creatorGroups: ["creators"],
    adminGroups: [],
    anonymousRead: true,
    vendors: registry.vendors,
    market: registry.market,
  });
  const server = http.createServer(app);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
  const H = (email) => ({ "x-test-session": JSON.stringify({ email, groups: ["creators"] }), "content-type": "application/json" });
  const Hn = (email) => ({ "x-test-session": JSON.stringify({ email }) });
  const manifest = (name, notes) => ({ name, description: "d", skills: [{ name: "s", description: "d", content: "x" }], ...(notes ? { notes } : {}) });
  try {
    const c1 = await fetch(`${base}/api/packs`, { method: "POST", headers: H("author@test"), body: JSON.stringify({ manifest: manifest("it-pack", "v1 原版") }) });
    const packId = (await c1.json()).id;
    // 订阅 v1
    await fetch(`${base}/api/packs/${packId}/subscribe`, { method: "POST", headers: Hn("reader@test") });
    let updates = await (await fetch(`${base}/api/packs/subscriptions/updates`, { headers: Hn("reader@test") })).json();
    assert.equal(updates.updates.length, 0, "无新作不提示");
    // v2 发布 (带 notes)
    await fetch(`${base}/api/packs`, { method: "POST", headers: H("author@test"), body: JSON.stringify({ packId, manifest: manifest("it-pack", "v2 改名了晨会钟点") }) });
    updates = await (await fetch(`${base}/api/packs/subscriptions/updates`, { headers: Hn("reader@test") })).json();
    assert.equal(updates.updates.length, 1);
    assert.equal(updates.updates[0].packId, packId);
    assert.equal(updates.updates[0].subscribedVersion, 1);
    assert.equal(updates.updates[0].latestVersion, 2);
    assert.equal(updates.updates[0].notes, "v2 改名了晨会钟点");
    // 未订阅主体的板面空
    updates = await (await fetch(`${base}/api/packs/subscriptions/updates`, { headers: Hn("other@test") })).json();
    assert.equal(updates.updates.length, 0);
  } finally {
    server.close();
    registry.close();
  }
});

// ── 5. digest ────────────────────────────────────────────────────────────────

test("digest: 订阅→决定性渲染(岗名/未报/拍板数/token行)→会话写入+窗口克制+退订即止", async () => {
  const fleet = await makeFleet();
  // 喂一票拍板与一岗未报(另一只报数)
  fleetDb.appendDecision({ id: "d_x", fleetId: fleet.id, memberId: "", question: "扩岗吗?", options: [{ value: "approve" }], severity: "high", submittedAt: Date.now() });
  const ceo = fleetDb.listMembers(fleet.id).find((m) => m.title === "CEO");
  fleetDb.appendReport({ id: "rep_1", fleetId: fleet.id, memberId: ceo.id, summary: "ok", metrics: { kpi1: 42 }, sessionId: "s1", createdAt: Date.now() - 3600_000 });

  const sub = fleetDb.upsertDigestSub({ id: "dg_test", fleetId: fleet.id, ownerEmail: "owner@test", cadence: "daily" });
  assert.ok(sub);
  const text = renderDigest({ db: fleetDb, fleet, now: Date.now() });
  assert.match(text, /晨报组/);
  assert.match(text, /拍板待决: 1 项/);
  assert.match(text, /汇报岗: 本期未报/);
  assert.match(text, /CEO: 产出=42/);
  assert.match(text, /近24h:/);

  const delivered = [];
  const fakeHistory = {
    createSession: () => {},
    recordMessage: (sid, role, body, _blocks, owner) => delivered.push({ sid, role, body, owner }),
  };
  const now = Date.now();
  const out = await runDueDigests({ db: fleetDb, chatHistory: fakeHistory, now, log: { warn() {} } });
  assert.equal(out.due, 1);
  assert.equal(out.sent, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sid, `fleet-digest:dg_test`);
  assert.equal(delivered[0].owner, "owner@test");
  assert.equal(fleetDb.listDigestSubscriptions({})[0].lastSentAt, now);

  // 窗口克制: lastRunAt 刚落, 不再 due
  assert.equal(determineDueSubscriptions({ db: fleetDb, now: now + 1000 }).length, 0);

  // 退订即止
  fleetDb.removeDigestSub(fleet.id, "owner@test", "daily");
  assert.equal(fleetDb.listDigestSubscriptions({}).length, 0);
});
