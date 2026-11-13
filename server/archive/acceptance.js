// ── 交付验收报告 ────────────────────────────────────────────────────────────
//
// 验收的唯一可信依据是**客户环境里实际拉到的数据**，不是接口通不通。
// 「200 OK 但一条没入库」是最常见的假通过，所以这里把"零数据"直接判成未通过。
//
// 四个实数（规格原话）：生效席位数 / 有消息会话数 / 同意会话占比 / 滞后曲线。
// 每一项都带分子分母——只给百分比会在分母为 0 时变成 0% 或 NaN 这种无法判读的东西。
//
// 幂等要求：同一份数据、同一个 `now`，两次生成必须完全一致（除生成时间戳）。
// 这让"验收报告"可以被当作证据：数值不会因为谁重跑一次就变形。

import { coverageReport, listLosses } from "./store.js";
import { evaluateLag } from "./window.js";

export const ACCEPTANCE_SCHEMA_VERSION = 1;
/** 24 小时内零入库 = 未通过。规格里写死的判据。 */
export const ZERO_DATA_WINDOW_HOURS = 24;

const DAY_MS = 86_400_000;

/**
 * 滞后曲线：最近 `days` 天每天入库多少条。
 *
 * 用"每天条数"而不是"平均滞后天数"：曲线能看出哪几天断了，
 * 平均值会把一段完整断流摊薄成一个看起来温和的数字。
 */
export function dailyVolume(db, { now = Date.now(), days = 14 } = {}) {
  const end = Math.floor(Number(now) / DAY_MS) * DAY_MS;
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const from = end - i * DAY_MS;
    const to = from + DAY_MS;
    const row = db
      .prepare("SELECT COUNT(*) n FROM archive_message WHERE sent_at >= ? AND sent_at < ?")
      .get(from, to);
    series.push({ dayStart: from, count: Number(row.n || 0) });
  }
  return series;
}

/**
 * 生成验收报告。
 *
 * @param {object} db
 * @param {{purchasedSeats?: number|null, effectiveSeats?: number|null, now?: number, seriesDays?: number}} [opts]
 */
export function buildAcceptanceReport(
  db,
  { purchasedSeats = null, effectiveSeats = null, now = Date.now(), seriesDays = 14 } = {},
) {
  const coverage = coverageReport(db, { purchasedSeats, effectiveSeats });
  const cursor = db.prepare("SELECT * FROM archive_cursor WHERE id='default'").get();
  const lastCheckedAt = Number(cursor?.last_checked_at || 0);
  const lastMessageAt = Number(cursor?.last_msg_at || 0) || coverage.messages.lastAt || 0;
  // 滞后曲线与巡检同口径：水位是「最后一次成功拉取」，不是最后一条消息
  // （安静通道按最后一条消息算会永远显示滞后，验收报告会误判"没在拉"）。
  const lastSuccessAt = Number(cursor?.last_success_at || 0);

  const lag = evaluateLag({ lastMessageAt, lastCheckedAt, lastSuccessAt, now });
  const series = dailyVolume(db, { now, days: seriesDays });
  const last24 = db
    .prepare("SELECT COUNT(*) n FROM archive_message WHERE sent_at >= ?")
    .get(Number(now) - ZERO_DATA_WINDOW_HOURS * 3_600_000);
  const messagesLast24h = Number(last24.n || 0);

  const seats = coverage.seats;
  const conv = coverage.conversations;

  // 判定只看三件事：席位是否真的算得出来、24 小时是否有数据、滞后是否已不可补偿。
  const reasons = [];
  if (seats.effective === null && seats.purchased === null) {
    reasons.push("seat_numbers_missing: 未提供购买/生效席位数，无法核对覆盖率");
  }
  if (coverage.messages.total === 0) {
    reasons.push("no_messages_at_all: 库中没有任何消息（接口通不等于通道在工作）");
  } else if (messagesLast24h === 0 && lag.level !== "lost") {
    reasons.push(
      `zero_ingest_24h: 最近 ${ZERO_DATA_WINDOW_HOURS} 小时零入库，需区分「确实无新消息」与「未就绪」`,
    );
  }
  if (lag.level === "lost") {
    reasons.push("history_unrecoverable: 滞后超过保留窗口，缺口不可补偿");
  }

  const report = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    generatedAt: Number(now),
    // ── 四个实数 ──
    seats: {
      purchased: seats.purchased,
      effective: seats.effective,
      gap: seats.gap,
    },
    sessions: {
      total: conv.total,
      withMessages: conv.withMessages,
      consented: conv.agreed,
      disagreed: conv.disagreed,
      // 分母为 0 时给 null：0% 会被读成"没人同意"，而事实是"还没有会话"
      consentRatio: conv.consentRatio,
    },
    messages: {
      total: coverage.messages.total,
      last24h: messagesLast24h,
      firstAt: coverage.messages.firstAt,
      lastAt: coverage.messages.lastAt,
    },
    media: coverage.media,
    lag: {
      level: lag.level,
      hoursSinceMessage: lag.hoursSinceMessage,
      hoursSinceCheck: lag.hoursSinceCheck,
      days: lag.days,
      series,
    },
    losses: listLosses(db),
    verdict: {
      ok: reasons.length === 0,
      reasons,
    },
    claimsFullCoverage: false,
    note:
      "验收以客户环境内实际入库数据为准；接口连通性不作为通过依据。" +
      "本报告不宣称覆盖全部历史：腾讯仅保留 5 天，断流缺口不可补偿。",
  };

  return report;
}

/** 一行摘要，给 CLI / 日志用。 */
export function acceptanceLine(report) {
  const parts = [report.verdict.ok ? "验收通过" : "验收未通过"];
  parts.push(`会话 ${report.sessions.withMessages}/${report.sessions.total}`);
  parts.push(`消息 ${report.messages.total}（近 24h ${report.messages.last24h}）`);
  parts.push(
    report.sessions.consentRatio === null
      ? "同意占比 无会话"
      : `同意 ${(report.sessions.consentRatio * 100).toFixed(1)}%`,
  );
  parts.push(`滞后 ${report.lag.level}`);
  if (report.losses.length) parts.push(`缺口 ${report.losses.length} 段`);
  return parts.join(" · ");
}
