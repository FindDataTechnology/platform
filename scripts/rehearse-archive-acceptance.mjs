#!/usr/bin/env node
// ── 7 天验收四张实数：压缩时间轴演排（任务 8.1）────────────────────────────
//
// ⚠ 先把话说死：**这不是客户真数**。
//
// 任务 8.1 要的是"连续跑 7 天，产出四张实数"。真实天数在这里造不出来，所以
// 这个脚本做的是另一件事：用**真实的代码路径**（runPullCycle + 同意 resolver +
// buildAcceptanceReport）把 7 天的时间轴压成 7 次调用，验证四张实数的**口径与
// 产出格式**是对的、以及"零入库不许判通过"这条闸门真的会红。
//
// 真数只能来自客户环境里连着跑 7 天；本脚本的结论不能代替它（所以 tasks.md 里
// 8.1 不勾）。
//
// 造的数据刻意包含四种会话，因为验收最容易在分母上骗人：
//   roomA、roomB  —— 同意且有消息
//   roomC        —— **不同意**（消息必须一条都进不来，但会话行要在：分母要有它）
//   roomD        —— 同意但零消息（"同意却没人聊"，也属于分母）
//
//   node scripts/rehearse-archive-acceptance.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const { runPullCycle } = await import("../server/archive/ingest.js");
const { createStubDriver } = await import("../server/archive/sdk.js");
const { createConsentCache } = await import("../server/archive/consent.js");
const { createConsentResolver } = await import("../server/archive/consent-api.js");
const { buildAcceptanceReport, acceptanceLine } = await import("../server/archive/acceptance.js");

const DAY = 86_400_000;
const NOW = Date.now();
const SEATS_PURCHASED = 5;
const SEATS_EFFECTIVE = 4; // 买 5 用 4：gap=1，验收必须把它显示出来

let failed = 0;
function check(name, cond, detail = "") {
  if (!cond) failed += 1;
  process.stdout.write(`${cond ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const dir = mkdtempSync(path.join(tmpdir(), "archive-acceptance-"));
const db = new DatabaseSync(path.join(dir, "archive.db"));
store.ensureArchiveSchema(db);

// ── 桩驱动：每批次按需产出消息 ──────────────────────────────────────────────
let seqCounter = 0;
const plains = new Map();

function messages({ roomid, msgtime, count }) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    seqCounter += 1;
    const id = `m${seqCounter}`;
    const ct = `ct${seqCounter}`;
    plains.set(ct, JSON.stringify({
      msgid: id, seq: seqCounter, from: "wmCUSTOMER", roomid, msgtime,
      msgtype: "text", text: { content: `第 ${seqCounter} 条` },
    }));
    out.push({ msgid: id, seq: seqCounter, publickey_ver: 3, encrypt_random_key: "rk", encrypt_chat_msg: ct });
  }
  return out;
}

function driverFor(batch) {
  let served = false;
  return createStubDriver(async (payload) => {
    if (payload.op === "getChatData") {
      if (served) return { ok: true, seq: batch.at(-1)?.seq ?? 0, messages: [] };
      served = true;
      return { ok: true, seq: batch.at(-1)?.seq ?? 0, messages: batch };
    }
    if (payload.op === "decryptData") {
      const plain = plains.get(payload.encryptChatMsg);
      if (!plain) return { ok: false, errCode: 10006, message: "no plain" };
      return { ok: true, plain };
    }
    return { ok: false, errCode: 9, message: `unexpected ${payload.op}` };
  });
}

// 同意：A/B/D 同意，C 不同意。用真 resolver，这样"明确不同意"会落库——
// 验收的同意占比分母就靠这些行，否则分母只剩同意会话、占比恒为 100%。
const AGREE = new Set(["roomA", "roomB", "roomD"]);
const resolver = createConsentResolver({
  db,
  cache: createConsentCache(),
  seatScope: ["zhangsan"],
  client: {
    async agreeOf(q) {
      const room = q.roomId ?? q.openId;
      return { status: AGREE.has(room) ? "agree" : "disagree", raw: "", statusChangeTime: 0, op: "check_room_agree" };
    },
  },
});

const perDay = [
  { roomA: 3, roomB: 2 },
  { roomA: 2, roomB: 2 },
  { roomA: 4, roomB: 1 },
  { roomA: 1, roomB: 3 },
  { roomA: 2, roomB: 2 },
  { roomA: 3, roomB: 3 },
  { roomA: 2, roomB: 2 },
];

try {
  // roomD：同意但始终没有消息（只让同意状态落库）
  await resolver.query("roomD");

  for (let d = 0; d < perDay.length; d += 1) {
    const dayStart = NOW - (perDay.length - 1 - d) * DAY;
    const batch = [
      ...messages({ roomid: "roomA", msgtime: dayStart, count: perDay[d].roomA }),
      ...messages({ roomid: "roomB", msgtime: dayStart, count: perDay[d].roomB }),
      // roomC 不同意：这些消息必须一条都进不来
      ...messages({ roomid: "roomC", msgtime: dayStart, count: 2 }),
    ];
    const r = await runPullCycle({
      db,
      driver: driverFor(batch),
      queryConsent: resolver.query,
      selfUserIds: ["zhangsan"],
      now: dayStart + 60_000,
    });
    if (d === 0) {
      check(
        "不同意会话的消息一条都不入库",
        r.rejectedConsent >= 2 && Number(store.coverageReport(db).messages.total) === perDay[0].roomA + perDay[0].roomB,
        `rejectedConsent=${r.rejectedConsent}`,
      );
    }
  }

  const report = buildAcceptanceReport(db, {
    purchasedSeats: SEATS_PURCHASED,
    effectiveSeats: SEATS_EFFECTIVE,
    now: NOW,
    seriesDays: 7,
  });

  process.stdout.write(`\n${acceptanceLine(report)}\n\n`);
  process.stdout.write(`${JSON.stringify({
    seats: report.seats,
    sessions: report.sessions,
    messages: report.messages,
    lagLevel: report.lag.level,
    series: report.lag.series.map((s) => s.count),
    verdict: report.verdict,
  }, null, 2)}\n\n`);

  // ── 四张实数的口径断言 ────────────────────────────────────────────────────
  const expectedMsgs = perDay.reduce((s, d) => s + d.roomA + d.roomB, 0);
  check("席位：购买 5 / 生效 4 / 差 1", report.seats.purchased === 5 && report.seats.effective === 4 && report.seats.gap === 1, JSON.stringify(report.seats));
  check(
    "会话：总 4（含不同意 1、同意但零消息 1）、有消息 2",
    report.sessions.total === 4 && report.sessions.withMessages === 2 && report.sessions.disagreed === 1,
    JSON.stringify(report.sessions),
  );
  check(
    "同意占比：3/4（分母含不同意与零消息会话，不是恒 100%）",
    Math.abs(Number(report.sessions.consentRatio) - 0.75) < 1e-9,
    String(report.sessions.consentRatio),
  );
  check("消息总数与逐日之和一致", report.messages.total === expectedMsgs, `${report.messages.total} vs ${expectedMsgs}`);
  check("滞后判定为 ok（最后一天有数据）", report.lag.level === "ok", report.lag.level);
  check(
    "滞后曲线 7 个点且逐日之和等于总消息数",
    report.lag.series.length === 7 && report.lag.series.reduce((s, x) => s + x.count, 0) === expectedMsgs,
    JSON.stringify(report.lag.series.map((s) => s.count)),
  );
  check("判定通过（三件事都满足）", report.verdict.ok === true, JSON.stringify(report.verdict.reasons));
  check("不得宣称全量覆盖", report.claimsFullCoverage === false);

  // 幂等：同一份数据、同一个 now，两次产出必须一致
  const again = buildAcceptanceReport(db, {
    purchasedSeats: SEATS_PURCHASED, effectiveSeats: SEATS_EFFECTIVE, now: NOW, seriesDays: 7,
  });
  check("同一 now 两次生成完全一致（可当证据）", JSON.stringify(again) === JSON.stringify(report));

  // ── 反面：24 小时零入库不许判通过 ────────────────────────────────────────
  {
    const later = NOW + 2 * DAY; // 之后两天没再拉
    const stale = buildAcceptanceReport(db, {
      purchasedSeats: SEATS_PURCHASED, effectiveSeats: SEATS_EFFECTIVE, now: later, seriesDays: 7,
    });
    check(
      "零入库 24h 必须判未通过（200 OK 不算通过）",
      stale.verdict.ok === false && stale.verdict.reasons.some((r) => r.startsWith("zero_ingest_24h")),
      JSON.stringify(stale.verdict.reasons),
    );
  }

  // ── 反面：没给席位数时不许假装算得出来 ───────────────────────────────────
  {
    const noSeats = buildAcceptanceReport(db, { now: NOW, seriesDays: 7 });
    check(
      "未提供席位数 → 明确拒绝出结论",
      noSeats.verdict.ok === false && noSeats.verdict.reasons.some((r) => r.startsWith("seat_numbers_missing")),
      JSON.stringify(noSeats.verdict.reasons),
    );
  }

  process.stdout.write(
    failed === 0
      ? "\n演排通过：四张实数的口径与产出格式都对。\n" +
          "⚠ 这不是客户真数：时间轴是压缩的、数据是造的。8.1 要的真数只能在客户环境连跑 7 天。\n"
      : `\n演排有 ${failed} 项不符。\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
