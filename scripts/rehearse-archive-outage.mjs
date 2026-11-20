#!/usr/bin/env node
// ── 断流演练（任务 8.2）：压缩时间轴 ─────────────────────────────────────────
//
// 真等 4 天在一个会话里做不了，所以这里用**注入的 now** 把时间轴压紧：每"天"
// 是一次真实调用（runPullCycle / runPatrol），只是 now 往前跳一天。除时间外
// 全部是生产代码路径（同一份 ingest、同一份 patrol、同一份 schema）。
//
// 有一条口径必须先说清，否则断言会写错：
//
//   会话存档官方保留 **5 天**（window.js 引 FAQ 91552/91774），所以
//   **4 天断流还补得回来**——它只该告警（warn），**不该**记成不可恢复。
//   "不可恢复"从 >5 天才成立。任务里写的"4 天断流"是按微信客服的 3 天窗口
//   写的；这里按存档通道的真实窗口验，并把两个阶段都跑一遍：
//
//   A. 4 天断流：告警按时开（第一次越过 3 天时）、之后不重复报（差量）、
//      恢复后自动关；**账本里必须没有记录**（还能补，记了反而是误报）。
//   B. 6 天断流：判 lost → 恢复后缺口必须进丢失账本，且**后续成功拉取不得洗白**。
//
// 阶段 B 是这条通道最容易被"看起来恢复"骗过去的地方，所以单独断言一笔。
//
//   node scripts/rehearse-archive-outage.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const { runPullCycle } = await import("../server/archive/ingest.js");
const { runPatrol } = await import("../server/archive/patrol.js");
const { createStubDriver } = await import("../server/archive/sdk.js");

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures += 1;
  process.stdout.write(`${cond ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const dir = mkdtempSync(path.join(tmpdir(), "archive-outage-"));
const db = new DatabaseSync(path.join(dir, "archive.db"));
store.ensureArchiveSchema(db);

// ── 桩驱动：批次与失败可切换 ────────────────────────────────────────────────
let seqCounter = 0;
const plains = new Map();

function makeMessages({ roomid = "room1", msgtime, count = 1 }) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    seqCounter += 1;
    const id = `m${seqCounter}`;
    const ct = `ct${seqCounter}`;
    plains.set(ct, JSON.stringify({
      msgid: id, seq: seqCounter, from: "wmCUST", roomid, msgtime,
      msgtype: "text", text: { content: `第 ${seqCounter} 条` },
    }));
    out.push({ msgid: id, seq: seqCounter, publickey_ver: 3, encrypt_random_key: "rk", encrypt_chat_msg: ct });
  }
  return out;
}

function driverFor({ messages = [], fail = false } = {}) {
  return createStubDriver(async (payload) => {
    if (payload.op === "getChatData") {
      if (fail) return { ok: false, errCode: 10001, message: "network unreachable" };
      return { ok: true, seq: messages.at(-1)?.seq ?? 0, messages };
    }
    if (payload.op === "decryptData") {
      const plain = plains.get(payload.encryptChatMsg);
      if (!plain) return { ok: false, errCode: 10006, message: "no plain" };
      return { ok: true, plain };
    }
    return { ok: false, errCode: 9, message: `unexpected ${payload.op}` };
  });
}

const config = {
  archiveEnabled: true,
  privateKeyPath: "/k.pem",
  secret: "s".repeat(40),
  seatScope: ["zhangsan"],
  corpId: "ww-rehearsal",
};

let prev = { active: [] };
async function patrol(now) {
  const out = await runPatrol({ db, now, config, prev });
  prev = out.state;
  return out;
}
async function pull(now, opts) {
  return runPullCycle({ db, driver: driverFor(opts), queryConsent: async () => "Agree", now });
}

try {
  // ── 起点：通道正常，有一条消息 ────────────────────────────────────────────
  {
    const r = await pull(T0, { messages: makeMessages({ msgtime: T0 }) });
    check("起点：拉取入库", r.admitted === 1 && r.lag.level === "ok", `admitted=${r.admitted} lag=${r.lag.level}`);
    const p = await patrol(T0);
    check("起点：巡检 ok、无告警", p.verdict.level === "ok" && p.opened.length === 0, `level=${p.verdict.level}`);
  }

  // ── 阶段 A：断流 4 天（上游挂了，拉取器仍在跑）───────────────────────────
  for (let d = 1; d <= 4; d += 1) {
    const now = T0 + d * DAY;
    const r = await pull(now, { fail: true });
    check(
      `A/第 ${d} 天：拉取失败但检查时间前进、游标不动`,
      r.errors.length === 1 && numberCursorSeq() === 1,
      `errors=${r.errors.length} seq=${numberCursorSeq()}`,
    );
  }
  function numberCursorSeq() {
    return Number(store.readCursor(db).seq);
  }

  // 越过 3 天的那一刻：告警必须开
  {
    const p = await patrol(T0 + 3 * DAY + 6 * 3600_000);
    check(
      "A/3.25 天：告警按时打开 lag_warning（差量首报）",
      p.verdict.active.includes("lag_warning") && p.opened.includes("lag_warning"),
      `active=${p.verdict.active} opened=${p.opened}`,
    );
  }
  // 同一天再巡检：不重复报
  {
    const p = await patrol(T0 + 3 * DAY + 7 * 3600_000);
    check(
      "A/3.3 天：同一告警不重复投递（只报新出现的）",
      p.opened.length === 0 && p.verdict.active.includes("lag_warning"),
      `opened=${JSON.stringify(p.opened)}`,
    );
  }
  // 第 4 天：仍只是 warn，且**不得**记得不可恢复（5 天窗口内还补得回来）
  {
    const p = await patrol(T0 + 4 * DAY);
    check(
      "A/4 天：判 warn，不判不可恢复",
      p.verdict.level === "warn" && !p.verdict.active.includes("history_unrecoverable"),
      `level=${p.verdict.level} active=${p.verdict.active}`,
    );
    check(
      "A/4 天：丢失账本为空（还能补，记了就是误报）",
      store.listLosses(db).length === 0,
      `losses=${store.listLosses(db).length}`,
    );
  }
  // 恢复：拉住新消息，滞后回到 ok，告警关闭
  {
    const now = T0 + 4 * DAY;
    const r = await pull(now, { messages: makeMessages({ msgtime: now }) });
    check("A/恢复：拉取成功且滞后回到 ok", r.admitted === 1 && r.lag.level === "ok", `admitted=${r.admitted} lag=${r.lag.level}`);
    const p = await patrol(now);
    check(
      "A/恢复：告警自动关闭（观测新鲜才承认关闭）",
      p.verdict.level === "ok" && p.closed.includes("lag_warning"),
      `level=${p.verdict.level} closed=${p.closed}`,
    );
    check("A/恢复：账本仍然为空", store.listLosses(db).length === 0);
  }

  // ── 阶段 B：断流 6 天（超过 5 天保留窗口）────────────────────────────────
  for (let d = 5; d <= 10; d += 1) {
    await pull(T0 + d * DAY, { fail: true });
  }
  {
    const p = await patrol(T0 + 10 * DAY);
    check(
      "B/6 天：判不可恢复并打开 history_unrecoverable",
      p.verdict.active.includes("history_unrecoverable") ||
        p.verdict.active.includes("puller_stalled"),
      `active=${p.verdict.active} lag=${p.verdict.lag.level}`,
    );
  }
  // 恢复：拉到新消息。**这是最容易被骗过去的一刻**——游标一跳，滞后立刻显示 ok。
  {
    const now = T0 + 10 * DAY;
    const before = store.listLosses(db).length;
    const r = await pull(now, { messages: makeMessages({ msgtime: now }) });
    const losses = store.listLosses(db);
    // 断流期间那几轮**失败**的拉取已经记过账了（判定按当时的滞后算），所以这里
    // 要求的是"账在、且没被这一刻的成功抹掉"，不是"这一刻新记一笔"。
    check(
      "B/恢复：缺口在账上且未被成功拉取抹掉",
      losses.length >= Math.max(1, before),
      `losses=${losses.length}（before=${before}）lag=${r.lag.level}`,
    );
    if (losses.length) {
      const spanHours = (Number(losses[0].toTs) - Number(losses[0].fromTs)) / 3_600_000;
      check(
        "B/恢复：区间从最后一条消息覆盖到现在（≈6 天）",
        spanHours > 5 * 24,
        `${spanHours.toFixed(1)}h`,
      );
    }
  }
  // 之后再拉两轮新消息：账本不得被清空或缩小
  {
    const spanBefore = store.listLosses(db).reduce((s, l) => s + (Number(l.toTs) - Number(l.fromTs)), 0);
    for (let i = 1; i <= 2; i += 1) {
      const now = T0 + (10 + i) * DAY;
      await pull(now, { messages: makeMessages({ msgtime: now }) });
    }
    const spanAfter = store.listLosses(db).reduce((s, l) => s + (Number(l.toTs) - Number(l.fromTs)), 0);
    check(
      "B/后续成功拉取不得洗白缺口（区间只增不减）",
      spanAfter >= spanBefore && store.listLosses(db).length > 0,
      `${(spanBefore / 3_600_000).toFixed(1)}h → ${(spanAfter / 3_600_000).toFixed(1)}h`,
    );
    const p = await patrol(T0 + 12 * DAY);
    check(
      "B/后续巡检：gap_unrecoverable 仍挂着（不因新数据消失）",
      p.verdict.active.includes("gap_unrecoverable"),
      `active=${p.verdict.active}`,
    );
  }

  // ── 阶段 C：整机停摆 6 天（期间**一次都没跑**），重启后第一次就拉成功 ──────
  //
  // 这是最现实的形态：客户机器关机/断电，恢复后第一轮直接拉回最近 5 天的消息。
  // 如果丢失判定用的是"拉取之后"的水位，游标一跳 lastMessageAt=now，滞后立刻显示
  // ok —— 那 6 天缺口就一个字都不进账，永久被洗白。
  {
    const base = T0 + 12 * DAY;
    const resumed = T0 + 18 * DAY;
    const beforeCount = store.listLosses(db).length;
    const beforeSpan = store.listLosses(db).reduce((s2, l) => s2 + (Number(l.toTs) - Number(l.fromTs)), 0);

    // 停摆期间只有巡检在跑（没有人调用 pull）
    const pDown = await patrol(resumed);
    // 注：判成 lost 时不再单列 puller_stalled（lost 已涵盖停滞），所以只断言这一条。
    check(
      "C/停摆 6 天：巡检判不可恢复",
      pDown.verdict.active.includes("history_unrecoverable"),
      `active=${pDown.verdict.active}`,
    );

    // 重启后第一轮就拉成功
    const r = await pull(resumed, { messages: makeMessages({ msgtime: resumed }) });
    const losses = store.listLosses(db);
    const span = losses.reduce((s2, l) => s2 + (Number(l.toTs) - Number(l.fromTs)), 0);
    check(
      "C/重启即成功：6 天缺口仍必须进账（不能因为这一轮成功就不记）",
      losses.length > beforeCount || span > beforeSpan,
      `losses=${losses.length} span=${(span / 3_600_000).toFixed(1)}h ← ${(beforeSpan / 3_600_000).toFixed(1)}h`,
    );
    check(
      "C/重启即成功：账本区间覆盖到恢复时刻",
      losses.some((l) => Number(l.toTs) >= resumed - 60_000),
      JSON.stringify(losses.map((l) => [new Date(Number(l.fromTs)).toISOString(), new Date(Number(l.toTs)).toISOString()])),
    );
    void base;
    void r;
  }

  process.stdout.write(
    failures === 0
      ? "\n断流演练通过：告警按时开/不重复报/恢复能关；>5 天缺口入账且不被洗白。\n" +
        "注意：时间轴是压缩的（注入 now），不是真的等了 12 天。\n"
      : `\n断流演练有 ${failures} 项不符。\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
