#!/usr/bin/env node
// ── kf 定时拉取 ─────────────────────────────────────────────────────────────
//
// kf 只保留 3 天消息：定时拉取是产品需求。这组测试守的是"它会自己跑、不会叠、
// 坏了看得见"。
//
// 四个断言最贵：
//   1. 慢周期不叠加（串联定时器）——setInterval 会让两个周期同时推同一段游标
//   2. 同一时刻只有一个周期在跑（inFlight）
//   3. 未配置时静默 disabled，不在日志里天天报警
//   4. 失败留状态而不只是打日志（日志会被刷掉）
//
//   node --test scripts/test-kf-scheduler.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { createKfSyncScheduler, kfConfigFromEnv, DEFAULT_INTERVAL_MS } = await import(
  "../server/archive/kf/scheduler.js"
);

const NOW = 1_700_000_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  return db;
}

function fakeClient(batches, { delayMs = 0, fail = null } = {}) {
  let i = 0;
  return {
    calls: 0,
    async syncMsg() {
      this.calls += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw fail;
      const b = batches[Math.min(i, batches.length - 1)];
      i += 1;
      return b;
    },
    async resolveOpenKfId() {
      return { openKfId: "kf1", source: "auto", accounts: [{ open_kfid: "kf1" }] };
    },
    async getCustomers() {
      return { customers: [], invalid: [] };
    },
  };
}

const cfg = { corpId: "ww-corp", secret: "S".repeat(40), openKfId: "", mediaDir: "" };

test("未配置：返回 unconfigured，不发请求，不抛错", async () => {
  const db = freshDb();
  const logs = [];
  const s = createKfSyncScheduler({
    db,
    readConfig: () => ({ ...cfg, corpId: "", secret: "" }),
    makeClient: () => {
      throw new Error("不该建客户端");
    },
    log: (m) => logs.push(m),
  });
  const out = await s.runOnce();
  assert.equal(out.ran, false);
  assert.equal(out.reason, "unconfigured");
  assert.deepEqual(out.missing, ["corpId", "secret"]);
  assert.ok(s.status().disabledReason.includes("缺少配置"));
  assert.equal(logs.length, 0, "未配置不该刷日志");
});

test("正常一轮：计数、时间戳、失败计数清零", async () => {
  const db = freshDb();
  const client = fakeClient([
    {
      nextCursor: "c1",
      hasMore: false,
      messages: [
        {
          msgid: "m1",
          open_kfid: "kf1",
          external_userid: "u1",
          send_time: Math.floor(NOW / 1000),
          origin: 3,
          msgtype: "text",
          text: { content: "在吗" },
        },
      ],
    },
  ]);
  const logs = [];
  const s = createKfSyncScheduler({
    db,
    readConfig: () => cfg,
    makeClient: () => client,
    log: (m) => logs.push(m),
    now: () => NOW,
  });
  const out = await s.runOnce();
  assert.equal(out.ran, true);
  assert.equal(out.report.inserted, 1);
  const st = s.status();
  assert.equal(st.cycles, 1);
  assert.equal(st.lastStartedAt, NOW);
  assert.equal(st.lastFinishedAt, NOW);
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(st.lastError, null);
  assert.ok(logs.some((l) => l.startsWith("[kf-sync] pulled=1")), logs.join("\n"));
});

test("「一条都没拉到且有错误」算失败周期，不能记成健康", async () => {
  const db = freshDb();
  const boom = new Error("errcode=45009 api freq out of limit");
  const s = createKfSyncScheduler({
    db,
    readConfig: () => cfg,
    makeClient: () => fakeClient([], { fail: boom }),
    log: () => {},
    now: () => NOW,
  });
  await s.runOnce();
  await s.runOnce();
  const st = s.status();
  assert.equal(st.consecutiveFailures, 2, "连续两轮全失败就要能看出来");
  assert.ok(st.lastError.includes("拉取失败"), st.lastError);
  assert.ok(st.lastReport.errors.length >= 1, "细节仍然留在 report 里");
});

test("有错误但确实拉到了消息：不算失败周期（部分成功）", async () => {
  const db = freshDb();
  const client = {
    calls: 0,
    async resolveOpenKfId() {
      return { openKfId: "kf1", source: "auto", accounts: [{ open_kfid: "kf1" }] };
    },
    async syncMsg() {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          nextCursor: "c1",
          hasMore: true,
          messages: [
            {
              msgid: "m1",
              open_kfid: "kf1",
              external_userid: "u1",
              send_time: Math.floor(NOW / 1000),
              origin: 3,
              msgtype: "text",
              text: { content: "在吗" },
            },
          ],
        };
      }
      throw new Error("第二批失败");
    },
    async getCustomers() {
      return { customers: [], invalid: [] };
    },
  };
  const s = createKfSyncScheduler({
    db,
    readConfig: () => cfg,
    makeClient: () => client,
    log: () => {},
    now: () => NOW,
  });
  await s.runOnce();
  const st = s.status();
  assert.equal(st.lastReport.pulled, 1);
  assert.equal(st.consecutiveFailures, 0, "拉到东西就不算失败周期");
  assert.ok(st.lastReport.errors.length >= 1, "但错误仍要留档");
});

test("周期内抛出（客户端构造失败）：计入 consecutiveFailures", async () => {
  const db = freshDb();
  const s = createKfSyncScheduler({
    db,
    readConfig: () => cfg,
    makeClient: () => {
      throw new Error("client boom");
    },
    log: () => {},
  });
  const out = await s.runOnce();
  assert.equal(out.ran, false);
  assert.equal(out.reason, "error");
  assert.equal(s.status().consecutiveFailures, 1);
  assert.ok(s.status().lastError.includes("client boom"));
});

test("同一时刻只有一个周期在跑：并发调用返回 skipped", async () => {
  const db = freshDb();
  const client = fakeClient([{ nextCursor: "c1", hasMore: false, messages: [] }], { delayMs: 30 });
  const s = createKfSyncScheduler({
    db,
    readConfig: () => cfg,
    makeClient: () => client,
    log: () => {},
  });
  const [a, b] = await Promise.all([s.runOnce(), s.runOnce()]);
  assert.equal(a.ran, true);
  assert.equal(b.ran, false);
  assert.equal(b.reason, "in-flight");
  assert.equal(client.calls, 1, "第二次不该真的去拉");
  assert.equal(s.status().skippedInFlight, 1);
});

test("定时器串联：上一轮结束才排下一轮，慢周期不叠加", async () => {
  const db = freshDb();
  const scheduled = [];
  const timers = {
    setTimeout(fn, delay) {
      scheduled.push({ fn, delay });
      return { unref() {} };
    },
    clearTimeout() {},
  };
  let cycles = 0;
  const s = createKfSyncScheduler({
    db,
    intervalMs: 1000,
    initialDelayMs: 0,
    readConfig: () => cfg,
    makeClient: () => {
      cycles += 1;
      return fakeClient([{ nextCursor: "c1", hasMore: false, messages: [] }]);
    },
    log: () => {},
    timers,
  });

  s.start();
  assert.equal(scheduled.length, 1, "启动只排一次");
  assert.equal(scheduled[0].delay, 0);

  // 手动触发第一次；跑完之前不应再排
  await scheduled[0].fn();
  assert.equal(scheduled.length, 2, "上一轮结束后才排下一轮");
  assert.equal(scheduled[1].delay, 1000);
  assert.equal(cycles, 1);
});

test("stop 之后不再排下一轮", async () => {
  const db = freshDb();
  const scheduled = [];
  const timers = {
    setTimeout(fn, delay) {
      scheduled.push({ fn, delay });
      return { unref() {} };
    },
    clearTimeout() {},
  };
  const s = createKfSyncScheduler({
    db,
    initialDelayMs: 0,
    readConfig: () => cfg,
    makeClient: () => fakeClient([{ nextCursor: "", hasMore: false, messages: [] }]),
    log: () => {},
    timers,
  });
  s.start();
  s.stop();
  await scheduled[0].fn();
  assert.equal(scheduled.length, 1, "stop 后不得再排");
  assert.equal(s.status().running, false);
});

test("status 是纯快照，改它不影响内部状态", async () => {
  const db = freshDb();
  const s = createKfSyncScheduler({
    db,
    readConfig: () => cfg,
    makeClient: () => fakeClient([{ nextCursor: "", hasMore: false, messages: [] }]),
    log: () => {},
  });
  const st = s.status();
  st.cycles = 999;
  assert.equal(s.status().cycles, 0);
});

test("maybeStartKfSyncJob：未启用时不打开数据库（不留空库）", async () => {
  const { maybeStartKfSyncJob } = await import("../server/archive/kf/scheduler.js");
  let opened = 0;
  const logs = [];
  const out = maybeStartKfSyncJob({
    getDb: () => {
      opened += 1;
      return freshDb();
    },
    env: {},
    log: (m) => logs.push(m),
  });
  assert.equal(out, null);
  assert.equal(opened, 0, "未启用就不该建库——否则每个 cell 启动都留一个空 kf.db");
  assert.ok(logs[0].includes("未启用"));
});

test("maybeStartKfSyncJob：启用但缺凭据时同样不建库", async () => {
  const { maybeStartKfSyncJob } = await import("../server/archive/kf/scheduler.js");
  let opened = 0;
  const logs = [];
  const out = maybeStartKfSyncJob({
    getDb: () => {
      opened += 1;
      return freshDb();
    },
    env: { KF_SYNC_ENABLED: "1" },
    log: (m) => logs.push(m),
  });
  assert.equal(out, null);
  assert.equal(opened, 0);
  assert.ok(logs[0].includes("缺少 KF_CORPID"));
});

test("maybeStartKfSyncJob：启用且凭据齐全才建库并启动", async () => {
  const { maybeStartKfSyncJob } = await import("../server/archive/kf/scheduler.js");
  let opened = 0;
  const db = freshDb();
  const out = maybeStartKfSyncJob({
    getDb: () => {
      opened += 1;
      return db;
    },
    env: { KF_SYNC_ENABLED: "1", KF_CORPID: "ww", KF_SECRET: "S".repeat(40) },
    log: () => {},
  });
  assert.equal(opened, 1);
  assert.ok(out, "应返回调度器");
  assert.equal(out.status().running, true);
  out.stop();
});

test("kfConfigFromEnv：enabled 必须显式 '1'", () => {
  assert.equal(kfConfigFromEnv({ KF_CORPID: "a", KF_SECRET: "b" }).enabled, false);
  assert.equal(kfConfigFromEnv({ KF_SYNC_ENABLED: "true" }).enabled, false, "只认 1");
  assert.equal(kfConfigFromEnv({ KF_SYNC_ENABLED: "1" }).enabled, true);
  assert.equal(kfConfigFromEnv({ KF_MEDIA_DIR: "/tmp/m" }).mediaDir, "/tmp/m");
  assert.equal(DEFAULT_INTERVAL_MS, 5 * 60 * 1000);
});

test("配置轮换：每个周期重建客户端（令牌不会沿用旧 secret）", async () => {
  const db = freshDb();
  let built = 0;
  const s = createKfSyncScheduler({
    db,
    readConfig: () => cfg,
    makeClient: () => {
      built += 1;
      return fakeClient([{ nextCursor: "", hasMore: false, messages: [] }]);
    },
    log: () => {},
  });
  await s.runOnce();
  await s.runOnce();
  assert.equal(built, 2, "每周期新建才能让轮换后的 secret 生效");
});
