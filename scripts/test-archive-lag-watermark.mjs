#!/usr/bin/env node
// ── 滞后水位：必须落在「最后一次成功拉取」，不是「最后一条消息」──────────────
//
// 两个方向都要钉住，缺一个就会修过头：
//
//   ① **安静但健康**：曾有消息，之后每轮都成功、上游明确回「没有新的」。
//      这不是丢失。旧口径（按最后一条消息算）会记一笔 144 小时的「不可补偿丢失」，
//      于是合规导出里带了一条不存在的缺口，而 `patrol` 的 history_unrecoverable 永不关闭。
//   ② **真断流**：每轮都失败。这才可能真的丢了（超过官方保留窗口），必须进账，
//      且后续成功不得洗白。
//
// 只测 ① 会把「把水位改成最后检查时间」这种改法放过去——那个改法能治好 ①，但会把 ② 洗白，
// 而 ② 恰恰是这两条通道最防的事。所以 ② 是 ① 的护栏，必须同文件、同时绿。
//
//   node --test scripts/test-archive-lag-watermark.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const store = await import("../server/archive/store.js");
const { runPullCycle } = await import("../server/archive/ingest.js");
const { createStubDriver } = await import("../server/archive/sdk.js");

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;
const ROOM = "room1";

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "lag-watermark-"));
  const db = new DatabaseSync(path.join(dir, "a.db"));
  store.ensureArchiveSchema(db);
  return { db, dir };
}

/** 一条真实形状的存档消息：外层只有密文字段，身份在明文里。 */
function oneMessage(msgtime) {
  const plain = JSON.stringify({
    msgid: "m1", seq: 1, from: "wmCUST", roomid: ROOM, msgtime,
    msgtype: "text", text: { content: "第一天问了个价" },
  });
  return createStubDriver(async (payload) => {
    if (payload.op === "getChatData") {
      return {
        ok: true, seq: 1,
        messages: [{ msgid: "m1", seq: 1, publickey_ver: 3, encrypt_random_key: "rk", encrypt_chat_msg: "ct1" }],
      };
    }
    if (payload.op === "decryptData") return { ok: true, plain };
    return { ok: false, errCode: 9, message: "unexpected" };
  });
}

/** 成功但空批：上游答复「没有新的」。 */
const emptyOk = () =>
  createStubDriver(async (payload) =>
    payload.op === "getChatData" ? { ok: true, seq: 0, messages: [] } : { ok: false, errCode: 9, message: "x" },
  );

/** 真断流：拉取直接抛。 */
const failing = () =>
  createStubDriver(async (payload) => {
    if (payload.op === "getChatData") throw new Error("network unreachable");
    return { ok: false, errCode: 9, message: "x" };
  });

test("① 曾有消息、之后 6 天每轮成功但零消息 → 不得记丢失", async () => {
  const { db, dir } = freshDb();
  try {
    // 第 1 天：一条消息
    await runPullCycle({ db, driver: oneMessage(T0), queryConsent: async () => "Agree", selfUserIds: ["me"], now: T0 });
    // 第 2..7 天：成功、零消息
    let last;
    for (let d = 1; d <= 6; d += 1) {
      last = await runPullCycle({ db, driver: emptyOk(), queryConsent: async () => "Agree", selfUserIds: ["me"], now: T0 + d * DAY });
    }

    assert.notEqual(
      last.lag.level,
      "lost",
      `拉取每轮都成功、上游答复过"没有新的"，不得判 lost（实际 ${last.lag.level}：${last.lag.reason}）`,
    );
    assert.equal(
      store.listLosses(db).length,
      0,
      "丢失账本不得因「没人说话」新增记录——账本一旦会编造缺口，它作为证据的价值就没了",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② 连续 6 天拉取失败 → 必须判 lost 且进账（别修过头）", async () => {
  const { db, dir } = freshDb();
  try {
    await runPullCycle({ db, driver: oneMessage(T0), queryConsent: async () => "Agree", selfUserIds: ["me"], now: T0 });
    let last;
    for (let d = 1; d <= 6; d += 1) {
      last = await runPullCycle({ db, driver: failing(), queryConsent: async () => "Agree", selfUserIds: ["me"], now: T0 + d * DAY });
    }

    assert.equal(last.lag.level, "lost", `真断流 6 天必须判 lost（实际 ${last.lag.level}）`);
    assert.ok(
      store.listLosses(db).length > 0,
      "真断流超过保留窗口必须进账；洗白真缺口是这两条通道最防的缺陷",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("③ 断流后恢复成功一轮 → 滞后回到 ok，但账本不得被清空", async () => {
  const { db, dir } = freshDb();
  try {
    await runPullCycle({ db, driver: oneMessage(T0), queryConsent: async () => "Agree", selfUserIds: ["me"], now: T0 });
    for (let d = 1; d <= 6; d += 1) {
      await runPullCycle({ db, driver: failing(), queryConsent: async () => "Agree", selfUserIds: ["me"], now: T0 + d * DAY });
    }
    const before = store.listLosses(db).length;
    assert.ok(before > 0);

    const now = T0 + 7 * DAY;
    const r = await runPullCycle({ db, driver: emptyOk(), queryConsent: async () => "Agree", selfUserIds: ["me"], now });

    assert.equal(r.lag.level, "ok", "成功拉取之后滞后应回到 ok");
    assert.ok(store.listLosses(db).length >= before, "账本只增不减");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
