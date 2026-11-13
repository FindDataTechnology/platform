// ── 存档巡检面 + 告警投递 ──────────────────────────────────────────────────
//
// 这一层要回答的不是"现在有没有数据"，而是"**要不要叫人起床**"。
// 因此它只做两件容易做错的事：
//
// 1. **差量边界**：只在告警码**新出现**时投递。每轮都把「滞后 3 天」重发一遍，
//    第一天就没人看了。所以投递内容是 `opened`，不是 `active`。
// 2. **缺数不算恢复**：观测不完整（本轮读失败、或游标早已不新鲜）时，
//    **不承认任何 code 消失**。否则"拉取器挂了"会被记成"恢复了"——
//    这是可靠性告警里最常见的一种假恢复。
//
// 另有一条口径：**零数据不判覆盖**。会话数为 0 时"同意占比低"没有意义
// （客户可能只是没聊过），所以覆盖类告警只在有会话时才可能成立。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { coverageReport, listLosses, readCursor, ensureArchiveSchema } from "./store.js";
import { evaluateLag, lossSummary } from "./window.js";

/** 游标超过这么久没更新，就认为"这一轮的观测不新鲜"，不足以宣布恢复。 */
export const DEFAULT_STALE_MS = 15 * 60 * 1000;

/** 告警码 → 人话。巡检输出里既要有码（机器读），也要有话（人读）。 */
export const CODE_TEXT = {
  never_checked: "从未成功拉取",
  puller_stalled: "拉取器停滞（超过一天没成功检查）",
  lag_warning: "滞后超过 3 天告警线",
  history_unrecoverable: "滞后超过 5 天，缺口不可补偿",
  gap_unrecoverable: "存在已记账的不可恢复缺口",
  seat_gap: "购买席位多于生效席位",
};

/**
 * 生成一次巡检判定。纯读，无副作用。
 *
 * @returns {{level: "ok"|"warn"|"lost"|"degraded", active: string[], fresh: boolean, ...}}
 */
export function buildPatrolVerdict({
  db,
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  config = {},
  degraded = false,
} = {}) {
  if (!db) throw new Error("buildPatrolVerdict 需要 db");
  ensureArchiveSchema(db);

  const cursor = readCursor(db);
  const lag = evaluateLag({
    lastMessageAt: cursor.lastMessageAt,
    lastCheckedAt: cursor.lastCheckedAt,
    // 水位只认「最后一次成功拉取」：用最后一条消息会让安静通道的
    // history_unrecoverable 永不关闭；用最后检查时间会把真断流洗白。
    lastSuccessAt: cursor.lastSuccessAt,
    now,
  });
  const coverage = coverageReport(db, {
    effectiveSeats: config.effectiveSeats ?? null,
    purchasedSeats: config.purchasedSeats ?? null,
  });
  const losses = lossSummary(listLosses(db));

  const checkedAt = Number(cursor.lastCheckedAt || 0);
  const fresh = !degraded && checkedAt > 0 && now - checkedAt <= staleMs;

  const active = [];
  if (lag.level === "never_checked") active.push("never_checked");
  if (lag.level === "stalled") active.push("puller_stalled");
  if (lag.level === "lost") active.push("history_unrecoverable");
  if (lag.level === "warn") active.push("lag_warning");
  if (losses.unrecoverable) active.push("gap_unrecoverable");
  // 零数据不判覆盖：会话都没有的时候，"席位多于生效"不是事故而是还没接上。
  if (Number(coverage.conversations.total || 0) > 0) {
    const gap = coverage.seats.gap;
    if (gap !== null && Number(gap) > 0) active.push("seat_gap");
  }

  let level;
  if (active.includes("history_unrecoverable") || active.includes("gap_unrecoverable")) level = "lost";
  else if (active.length) level = "warn";
  else level = fresh ? "ok" : "degraded";

  return {
    level,
    active: [...new Set(active)].sort(),
    fresh,
    degraded: degraded || !fresh,
    lag,
    coverage,
    losses,
    reasons: active.map((c) => CODE_TEXT[c] || c),
    checkedAt: checkedAt || null,
  };
}

/** 两个 active 集合的差量。投递只看 opened。 */
export function transition(prevActive = [], nextActive = []) {
  const prev = new Set(prevActive || []);
  const next = new Set(nextActive || []);
  return {
    opened: [...next].filter((c) => !prev.has(c)).sort(),
    closed: [...prev].filter((c) => !next.has(c)).sort(),
  };
}

/**
 * 跑一轮巡检并把"该不该报"算清楚。
 *
 * `degraded` 由调用方给：本轮读取失败、配置读不到等都传 true。此时**不认关闭**。
 */
export async function runPatrol({
  db,
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  config = {},
  degraded = false,
  prev = { active: [] },
  deliver = null,
} = {}) {
  const verdict = buildPatrolVerdict({ db, now, staleMs, config, degraded });
  const { opened, closed } = transition(prev?.active || [], verdict.active);

  // 缺数不算恢复：观测不完整时，上一轮还成立的问题继续算成立。
  const carried = verdict.fresh ? [] : (prev?.active || []).filter((c) => !verdict.active.includes(c));
  const active = [...new Set([...verdict.active, ...carried])].sort();
  const effectiveClosed = verdict.fresh ? closed : [];

  let delivered = null;
  if (opened.length > 0 && typeof deliver === "function") {
    delivered = await deliver({
      level: verdict.level,
      opened,
      openedText: opened.map((c) => CODE_TEXT[c] || c),
      verdict,
      at: now,
    });
    if (delivered === undefined) delivered = true;
  }

  return {
    verdict,
    opened,
    closed: effectiveClosed,
    carried: carried.sort(),
    delivered,
    state: { active, at: now },
  };
}

// ── 状态持久化（CLI 跨轮次做差量要用）──────────────────────────────────────

export function readPatrolState(file) {
  if (!file || !existsSync(file)) return { active: [], at: null };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return { active: Array.isArray(j.active) ? j.active.map(String) : [], at: j.at ?? null };
  } catch {
    // 状态文件坏了不能当成"之前一切正常"——那会让所有告警重新开火一次。
    return { active: [], at: null, corrupt: true };
  }
}

export function writePatrolState(file, state) {
  if (!file) return;
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ active: state.active || [], at: state.at ?? null }, null, 2)}\n`);
}
