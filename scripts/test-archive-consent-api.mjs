#!/usr/bin/env node
// ── 同意状态接口（任务 3.1c）─────────────────────────────────────────────────
//
// 这组测试守的是三个"看起来能用、其实会静默丢数据"的形态：
//
//   1. 角色猜错 → 官方回 Disagree → 我们把客户的会话当成"客户不同意"永久丢弃。
//      所以判不出该问谁时**必须不发请求**。
//   2. 查询失败被当成"不同意" → 接口一坏，全企业的会话静默停止入库，
//      而报告只显示"入库 0 条"。失败要计数、要留最后一条错误。
//   3. 令牌/secret 出现在错误正文 → 进日志、进告警、进用户截图。
//
// 全部用注入 fetch 跑，不需要真凭据；但走的**是**真实路径（URL/请求体/回包形状）。
//
//   node --test scripts/test-archive-consent-api.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const {
  createAgreeClient,
  createConsentResolver,
  resolveAgreeQuery,
  ConsentIndeterminateError,
  PATH_SINGLE,
  PATH_ROOM,
} = await import("../server/archive/consent-api.js");
const { createConsentCache } = await import("../server/archive/consent.js");
const store = await import("../server/archive/store.js");

const NOW = 1_700_000_000_000;
const SECRET = "s".repeat(40);
const TOKEN = "T".repeat(40);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

/** 记录每次请求的假 fetch：token 与业务接口分开回。 */
function makeFetch({ agreeStatus = "Agree", statusChangeTime = NOW - 1000, errcode = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body: init?.body });
    if (u.pathname === "/cgi-bin/gettoken") {
      return { status: 200, json: async () => ({ errcode: 0, access_token: TOKEN, expires_in: 7200 }) };
    }
    if (errcode !== 0) {
      return {
        status: 200,
        json: async () => ({ errcode, errmsg: `bad request: access_token=${TOKEN}` }),
      };
    }
    return {
      status: 200,
      json: async () => ({ errcode: 0, errmsg: "ok", agree_status: agreeStatus, status_change_time: statusChangeTime }),
    };
  };
  return { fetchImpl, calls };
}

test("群聊走 check_room_agree，请求体只带 roomid", async () => {
  const { fetchImpl, calls } = makeFetch({ agreeStatus: "Agree" });
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  const res = await client.agreeOf({ kind: "room", roomId: "wrROOM" });

  assert.equal(res.status, "agree");
  assert.equal(res.statusChangeTime, NOW - 1000, "变更时间要来自官方，不是我们自己的 now");
  const biz = calls.find((c) => c.path === PATH_ROOM);
  assert.ok(biz, `应打 ${PATH_ROOM}，实际：${calls.map((c) => c.path).join(",")}`);
  assert.deepEqual(JSON.parse(biz.body), { info: [{ roomid: "wrROOM" }] });
  assert.equal(biz.query.access_token, TOKEN);
});

test("单聊走 check_single_agree，userid 与 exteranalopenid 不能对调", async () => {
  const { fetchImpl, calls } = makeFetch({ agreeStatus: "Disagree" });
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  const res = await client.agreeOf({ kind: "single", userId: "zhangsan", openId: "wmOPEN" });

  assert.equal(res.status, "disagree");
  const biz = calls.find((c) => c.path === PATH_SINGLE);
  assert.ok(biz, "应打 check_single_agree");
  assert.deepEqual(JSON.parse(biz.body), { info: [{ userid: "zhangsan", exteranalopenid: "wmOPEN" }] });
});

test("令牌缓存：两次查询只取一次票", async () => {
  const { fetchImpl, calls } = makeFetch();
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  await client.agreeOf({ kind: "room", roomId: "r1" });
  await client.agreeOf({ kind: "room", roomId: "r2" });
  assert.equal(calls.filter((c) => c.path === "/cgi-bin/gettoken").length, 1);
});

test("错误正文里不得出现 access_token 或 secret", async () => {
  const { fetchImpl } = makeFetch({ errcode: 40001 });
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  await assert.rejects(
    () => client.agreeOf({ kind: "room", roomId: "r1" }),
    (err) => {
      const text = `${err.message} ${JSON.stringify(err.detail || {})}`;
      assert.ok(!text.includes(SECRET), `错误里带了 secret：${text}`);
      assert.ok(!text.includes(TOKEN), `错误里带了 access_token：${text}`);
      return true;
    },
  );
});

test("301042 = 出口 IP 不在可信列表，单独成类", async () => {
  const { fetchImpl } = makeFetch({ errcode: 301042 });
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  await assert.rejects(
    () => client.agreeOf({ kind: "room", roomId: "r1" }),
    (err) => err.name === "WhiteIpMismatchError",
  );
});

test("角色判不出来时不发请求（猜错方向=把客户会话永久丢弃）", () => {
  // 两端都不是我方席位：可能是内部同事互聊，也可能席位范围没配全
  assert.throws(
    () => resolveAgreeQuery("dm:a:b", { seatScope: ["zhangsan"] }),
    (err) => err instanceof ConsentIndeterminateError && err.reason === "no_seat_in_pair",
  );
  // 两端都是我方席位：内部会话，官方接口没有"问谁"的语义
  assert.throws(
    () => resolveAgreeQuery("dm:a:b", { seatScope: ["a", "b"] }),
    (err) => err.reason === "both_sides_are_seats",
  );
  // 正好一端是我方：这才是合法的单聊查询
  assert.deepEqual(resolveAgreeQuery("dm:wmOPEN:zhangsan", { seatScope: ["zhangsan"] }), {
    kind: "single",
    userId: "zhangsan",
    openId: "wmOPEN",
  });
  // 群聊
  assert.deepEqual(resolveAgreeQuery("wrROOM", { seatScope: [] }), { kind: "room", roomId: "wrROOM" });
});

test("判不出角色时 resolver 不发请求、计 indeterminate、按未同意处理", async () => {
  const db = freshDb();
  const { fetchImpl, calls } = makeFetch();
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  const resolver = createConsentResolver({ client, db, cache: createConsentCache({ now: () => NOW }), seatScope: ["zhangsan"], now: () => NOW });

  const status = await resolver.query("dm:a:b");
  assert.equal(status, "unknown");
  assert.equal(calls.length, 0, "判不出问谁就不该打任何请求");
  assert.equal(resolver.stats().indeterminate, 1);
});

test("查询失败 → 返回 unknown（不入库）但要计数并留错误", async () => {
  const db = freshDb();
  const { fetchImpl } = makeFetch({ errcode: 40013 });
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  const resolver = createConsentResolver({ client, db, now: () => NOW });

  const status = await resolver.query("wrROOM");
  assert.equal(status, "unknown", "失败不能当同意");
  assert.equal(resolver.stats().errors, 1);
  assert.ok(resolver.stats().lastError, "必须留下最后一条错误，否则'接口坏了'看起来像'客户不同意'");
  assert.equal(store.getAgreeState(db, "wrROOM"), "unknown", "失败不得写进 agree_state");
});

test("明确状态才落库：agree 写入 agree_state 与 agree_at", async () => {
  const db = freshDb();
  const { fetchImpl } = makeFetch({ agreeStatus: "Agree", statusChangeTime: NOW - 5000 });
  const client = createAgreeClient({ fetchImpl, corpId: "ww1", secret: SECRET, now: () => NOW });
  const resolver = createConsentResolver({ client, db, cache: createConsentCache({ now: () => NOW }), now: () => NOW });

  assert.equal(await resolver.query("wrROOM"), "agree");
  assert.equal(store.getAgreeState(db, "wrROOM"), "agree");
  const row = db.prepare("SELECT agree_at FROM archive_conversation WHERE conversation_id=?").get("wrROOM");
  assert.equal(Number(row.agree_at), NOW - 5000, "agree_at 用官方的变更时间");
});

// 跨进程失效：回调在网关进程落一条水位，拉取进程的缓存必须让位。
test("缓存命中前比对回调水位：回调更新则重新查询", async () => {
  const db = freshDb();
  let calls = 0;
  // 时钟必须能往前走：冻结时钟下"回调水位"永远在缓存之后，会得到一个假的永不命中。
  // 真实情形就是时间在推进，所以这里也推进。
  let clock = NOW;
  const cache = createConsentCache({ now: () => clock });
  const resolver = createConsentResolver({
    db,
    cache,
    now: () => clock,
    client: {
      async agreeOf() {
        calls += 1;
        return { status: "agree", raw: "Agree", statusChangeTime: clock, op: "check_room_agree" };
      },
    },
  });

  assert.equal(await resolver.query("wrROOM"), "agree");
  assert.equal(await resolver.query("wrROOM"), "agree");
  assert.equal(calls, 1, "没回调时应命中缓存");

  // 网关收到"客户撤回同意"，写下水位（时间比缓存新）
  store.recordConsentEvent(db, "wrROOM", clock + 1);
  clock += 10;
  assert.equal(await resolver.query("wrROOM"), "agree");
  assert.equal(calls, 2, "水位比缓存新，必须重新问一次——否则撤回同意后还会继续写满一个 TTL");

  // 问答一次之后缓存时间已更新，再问又命中
  assert.equal(await resolver.query("wrROOM"), "agree");
  assert.equal(calls, 2);
});

test("全局水位（认不出会话）对所有会话生效", async () => {
  const db = freshDb();
  let calls = 0;
  const resolver = createConsentResolver({
    db,
    cache: createConsentCache({ now: () => NOW }),
    now: () => NOW,
    client: {
      async agreeOf() {
        calls += 1;
        return { status: "agree", raw: "Agree", statusChangeTime: NOW, op: "check_room_agree" };
      },
    },
  });
  await resolver.query("r1");
  store.recordConsentEvent(db, "*", NOW + 1);
  await resolver.query("r1");
  assert.equal(calls, 2);
});
