// 报数 digest 的呈现（fix-fleet-digest-rendering）。
//
// 实测（2026-11-13 08:44Z，cell 1da519d4c1c0bf89，11 条订阅全部 sent）：
//
//   集群日报 · 跨境电商政策盯梢集群
//   · 政策巡检员: 政策条目=[object Object]，头条=[object Object]
//
// 报数合约里指标值是对象（近 7 天 316 条只有 {value} 与 {value,delta} 两种形状，
// 没有一条标量），而渲染器写的是 String(v) —— 所以每一个槽位、每一条 digest
// 都必然是这个样子。投递会话的标题同理：recordMessage 只从 user 角色派生标题，
// assistant 一律 "New chat"，11 条 digest 在侧栏并排全叫 "New chat"。
//
// 这两条是本文件要钉住的全部内容：值要呈现成值，标题要是内容首行。

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDigest, runDueDigests } from "../server/fleet-digest.js";

const NOW = 1_800_000_000_000;

const fleet = { id: "f1", name: "跨境电商政策盯梢集群", state: "active", ownerEmail: "owner@example.com" };

const member = (id, title, slots) => ({ id, title, fleetId: "f1", kpiSlots: slots ?? [] });

function fakeDb({ reports = {}, members = [], decisions = [], subs = [] } = {}) {
  return {
    listMembers: () => members,
    listDecisions: () => decisions,
    spendProjection: () => ({ windows: { "24h": { turns: 7, runs: 6, usageInput: 8124, usageOutput: 4998 } } }),
    latestReportFor: (id) => reports[id] ?? null,
    getFleet: () => fleet,
    listDigestSubscriptions: () => subs,
    touchDigestRun: () => {},
  };
}

// ── 1. 槽位取值 ──────────────────────────────────────────────────────────────

test("对象形状的指标呈现值，不出现 [object Object]", () => {
  const db = fakeDb({
    members: [member("m1", "政策巡检员", [{ key: "policy_items", label: "政策条目" }])],
    reports: { m1: { createdAt: NOW - 3600_000, metrics: { policy_items: { value: 92 } } } },
  });
  const text = renderDigest({ db, fleet, now: NOW });
  assert.ok(!text.includes("[object Object]"), `must not stringify metric objects:\n${text}`);
  assert.match(text, /政策条目=92/);
});

test("短 delta 以括号附在主值之后", () => {
  const db = fakeDb({
    members: [member("m1", "巡检员")],
    reports: { m1: { createdAt: NOW - 3600_000, metrics: { scanned: { value: 8, delta: "+2" } } } },
  });
  const text = renderDigest({ db, fleet, now: NOW });
  assert.match(text, /scanned=8（\+2）/);
});

test("长句 delta 不进 digest（留在报数车道）", () => {
  const longDelta = "去重异常源 92（fail_streak≥3:6 / no_success:4 / zero_output:13 / stale>48h:77，含重叠）";
  const db = fakeDb({
    members: [member("m1", "巡检员")],
    reports: { m1: { createdAt: NOW - 3600_000, metrics: { anomalies: { value: 92, delta: longDelta } } } },
  });
  const text = renderDigest({ db, fleet, now: NOW });
  assert.match(text, /anomalies=92/);
  assert.ok(!text.includes("fail_streak"), `a long delta must not bloat the digest:\n${text}`);
  assert.ok(!text.includes("[object Object]"));
});

test("数组与标量与 null 都有确定性呈现", () => {
  const db = fakeDb({
    members: [member("m1", "巡检员")],
    reports: {
      m1: {
        createdAt: NOW - 3600_000,
        metrics: { tags: ["a", "b"], plain: 5, nothing: null },
      },
    },
  });
  const text = renderDigest({ db, fleet, now: NOW });
  assert.ok(!text.includes("[object Object]"), text);
  assert.match(text, /tags=a\/b/, "arrays join deterministically");
  assert.match(text, /plain=5/);
  assert.match(text, /nothing=(?![^\n])/, "null renders empty");
});

test("没有报数的岗位仍是「本期未报」", () => {
  const db = fakeDb({ members: [member("m1", "投稿岗")] });
  const text = renderDigest({ db, fleet, now: NOW });
  assert.match(text, /· 投稿岗: 本期未报/);
});

// ── 2. 投递会话标题 ──────────────────────────────────────────────────────────

function fakeChatHistory({ existing = false } = {}) {
  const state = { created: 0, recorded: [], titles: [] };
  return {
    state,
    sessionExists: () => existing || state.created > 0,
    createSession: () => { state.created += 1; },
    recordMessage: (id, role, content) => { state.recorded.push({ id, role, content }); },
    setTitle: (id, title) => { state.titles.push({ id, title }); return title; },
  };
}

const subs = () => [{ id: "dg_test", fleetId: "f1", ownerEmail: "owner@example.com", cadence: "daily", lastRunAt: null }];

test("新建的 digest 会话标题是内容首行", async () => {
  const chat = fakeChatHistory();
  const out = await runDueDigests({ db: fakeDb({ members: [member("m1", "投稿岗")], subs: subs() }), chatHistory: chat, now: NOW, log: { warn() {} } });
  assert.equal(out.sent, 1);
  assert.equal(chat.state.titles.length, 1, "a brand-new session gets exactly one title write");
  assert.equal(chat.state.titles[0].title, "集群日报 · 跨境电商政策盯梢集群");
});

test("已存在的 digest 会话不被重写标题", async () => {
  const chat = fakeChatHistory({ existing: true });
  await runDueDigests({ db: fakeDb({ members: [member("m1", "投稿岗")], subs: subs() }), chatHistory: chat, now: NOW, log: { warn() {} } });
  assert.equal(chat.state.titles.length, 0, "the owner may have renamed it — never overwrite");
  assert.equal(chat.state.recorded.length, 1, "the digest itself still lands");
});
