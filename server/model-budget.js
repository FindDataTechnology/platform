// Model-surface budget gate (add-model-surface-budget-gate): 宪章 §7 质量门
// 第二刀。三级预算（single/daily/monthly，token 计），窗口数据落 SQLite
// `model_budget`（model+tier 键），超限事件落 `budget_exhausted_log`。
//
// 语义（design 定谳）：
//   - daily/monthly 是入口前置检查：超限的候选链跳在 normalizeModelForJob
//     的 walk 里被跳过（自然走降级链下一跳）；全链超限 → budget_exhausted
//     失败（不进重试，防止死循环）。
//   - single 是结算面检查：一回合真实用量超单次上限 → 记事件 + 该回合走
//     既有的一次性降级重试（同 retryFast 形状，仍是一跳）。
//   - 消费在结算缝：runPersonaTurn 落幕时按「每次 attempt 的真实用量」
//     逐 attempt 记账（降级弃掉的半程也如实入账，不藏）。
//   - 窗口懒滚动（读到过期窗口就地重置）+ 显式 resetDaily/resetMonthly
//     cron job（attachModelBudgetReset）双保险。
//
// Degrade-open 纪律：引擎任何失败都不许挡住它看着的回合——所有入口
// try/catch，坏了退回「无预算门」旧行为。
//
// 表归本模块自建（CREATE TABLE IF NOT EXISTS，幂等），不进 fleets-db.js
// 的 schema 块：预算法自包含，回滚=摘 env 开关，库里的空表无害。

import { setTimeout as delay } from "node:timers/promises";

const DAY_MS = 24 * 60 * 60 * 1000;

// UTC 日界/月界键：daily 窗口按 UTC 日对齐（spec：每日 00:00 UTC 重置），
// monthly 按 UTC 月 1 号对齐。
export function utcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcMonthKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

export function budgetConfigFromEnv(env = process.env) {
  const int = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
  };
  return {
    enabled: String(env.MODEL_BUDGET_ENABLED ?? "").trim() === "1" || String(env.MODEL_BUDGET_ENABLED ?? "").toLowerCase() === "true",
    // 预警比例（4.2）：用量到上限的这个比例就产出一条预警事件，
    // 让"额度快烧完"在变成成批 budget_exhausted 之前就可见。
    // 0 或非法值 = 关闭；默认 0.9。
    warnRatio: (() => {
      const n = Number(env.MODEL_BUDGET_WARN_RATIO);
      if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.9;
      return n;
    })(),
    single: int(env.MODEL_BUDGET_SINGLE, 8192),
    daily: int(env.MODEL_BUDGET_DAILY, 1_000_000),
    monthly: int(env.MODEL_BUDGET_MONTHLY, 10_000_000),
  };
}

// 回合真实用量的 token 合计：input + output + cache 三轴全入（缓存读/写
// 也是真金白银的上下文面）。字段名对齐 dsh TokenUsage 的实测形状
//（inputTokens/outputTokens——dsh-events.js:533 起）与 normalizeUsage 的
// 别名组（fleet-events.js:102）；缺失轴当 0，两主轴都缺当 null（调用方
// 跳过记账，不阻塞、不猜）。
export function turnTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const pick = (...names) => {
    for (const n of names) {
      const v = usage[n];
      if (Number.isFinite(v) && v >= 0) return Math.round(v);
    }
    return 0;
  };
  const input = pick("input", "inputTokens", "promptTokens", "input_tokens", "prompt_tokens");
  const output = pick("output", "outputTokens", "completionTokens", "output_tokens", "completion_tokens");
  const hasPrimary = ["input", "inputTokens", "promptTokens", "input_tokens", "prompt_tokens", "output", "outputTokens", "completionTokens", "output_tokens", "completion_tokens"]
    .some((n) => Number.isFinite(usage[n]) && usage[n] >= 0);
  if (!hasPrimary) return null;
  return input + output + pick("cacheReadTokens") + pick("cacheWriteTokens") + pick("reasoningTokens");
}

export function createBudgetEngine({ db, config, now = () => Date.now() } = {}) {
  const cfg = config ?? budgetConfigFromEnv();
  // fleet 库有两种持有面：wrapper（createFleetDatabase/getFleetDatabase 的
  // 返回，带业务方法）或裸 better-sqlite3 句柄。取能 exec 的那层。
  const raw = typeof db?.exec === "function" ? db : db?.db;
  db = raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_budget (
      model TEXT NOT NULL,
      tier TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      limit_tokens INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(model, tier)
    );
    CREATE INDEX IF NOT EXISTS idx_model_budget_tier ON model_budget(tier, window_end);
    CREATE TABLE IF NOT EXISTS budget_exhausted_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      tier TEXT NOT NULL,
      used INTEGER NOT NULL,
      limit_tokens INTEGER NOT NULL,
      job_id TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_budget_log_created ON budget_exhausted_log(created_at);

    -- 阈值预警（4.2）：**按窗口幂等**——同一 (model, tier, window_start) 只记一条。
    -- 为什么单独一张表而不是复用 budget_exhausted_log：耗尽与"快到上限"是两类事件，
    -- 混在一起后"有多少真正撞墙"就数不清了（当天 68% 的失败是耗尽，预警必须可分辨）。
    -- 只落库，不自己发通知：出口归 wire-alert-delivery（该 change 已归档，五线接通）。
    CREATE TABLE IF NOT EXISTS budget_warning_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      tier TEXT NOT NULL,
      used INTEGER NOT NULL,
      limit_tokens INTEGER NOT NULL,
      ratio REAL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(model, tier, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_budget_warning_created ON budget_warning_log(created_at);

    -- 分账表（harden-fleet-execution-economics 4.1）：**记账面，不参与准入判定**。
    -- 为什么不改 model_budget 的键：它的 UNIQUE(model,tier) 是内联约束，往键里加
    -- owner/fleet 必须重建表；而这段代码在 32 个 cell 的库上开机即跑，
    -- 重建失败 = 整库 disabled（历史上裸 ALTER 抛错就是这么翻车的）。
    -- 所以准入仍走全局 (model,tier) 行（行为零变化），本表只回答"谁把额度烧完了"。
    -- 归属为"未知"而不是某个默认舰队：宁可显式 unknown，也不把别人的用量塞给某个线。
    CREATE TABLE IF NOT EXISTS model_budget_scope (
      owner TEXT NOT NULL,
      fleet TEXT NOT NULL,
      model TEXT NOT NULL,
      tier TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(owner, fleet, model, tier)
    );
    CREATE INDEX IF NOT EXISTS idx_budget_scope_window ON model_budget_scope(tier, window_end);
  `);

  const tierLimit = { single: cfg.single, daily: cfg.daily, monthly: cfg.monthly };

  const getRow = (model, tier) =>
    db.prepare(`SELECT model, tier, used, limit_tokens AS limitTokens, window_start AS windowStart, window_end AS windowEnd FROM model_budget WHERE model = ? AND tier = ?`).get(model, tier) ?? null;

  // 窗口行惰性对齐：不存在则建满额新窗；越界则就地滚窗（used 归零）。
  // 返回滚动后的行。monthly 窗尾对齐下月 1 号 UTC（+30d 会让二月压进三月，
  // 跨月窗重叠三天使三月前几日记错账）。
  // 窗口边界（daily=UTC 日；monthly=本月 1 号 → 下月 1 号 UTC，避免 +30d
  // 让二月压进三月造成跨月窗重叠）。抽出来给分账表复用，两处口径必须一致，
  // 否则分账合计与全局用量对不上。
  function windowBounds(tier, nowMs = now()) {
    if (tier === "monthly") {
      const mKey = utcMonthKey(nowMs);
      const start = Date.parse(`${mKey}-01T00:00:00Z`);
      const [y, m] = mKey.split("-").map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      return { start, end: Date.parse(`${next}-01T00:00:00Z`) };
    }
    const start = Date.parse(`${utcDayKey(nowMs)}T00:00:00Z`);
    return { start, end: start + DAY_MS };
  }

  function rollWindow(model, tier) {
    const nowMs = now();
    const limit = tierLimit[tier];
    const existing = getRow(model, tier);
    if (existing && nowMs < existing.windowEnd) return existing;
    const { start, end } = windowBounds(tier, nowMs);
    db.prepare(`
      INSERT INTO model_budget (model, tier, used, limit_tokens, window_start, window_end, updated_at)
      VALUES (?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(model, tier) DO UPDATE SET
        used = 0, limit_tokens = excluded.limit_tokens,
        window_start = excluded.window_start, window_end = excluded.window_end,
        updated_at = excluded.updated_at
    `).run(model, tier, limit, start, end, nowMs);
    return getRow(model, tier);
  }

  function logExhausted(model, tier, used, limitTokens, meta = {}) {
    db.prepare(`INSERT INTO budget_exhausted_log (model, tier, used, limit_tokens, job_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(model, tier, used, limitTokens, meta.jobId ?? null, meta.sessionId ?? null, now());
  }

  // ── 分账（4.1）：只记账，不参与准入 ────────────────────────────────
  //
  // 归属缺失一律记 "unknown"，MUST NOT 落进任何具体舰队——"不知道是谁"与
  // "就是默认那条线"是两件事，混起来会把别人的用量算到无辜的线上。
  const UNKNOWN_SCOPE = "unknown";

  function scopeKey(meta = {}) {
    const owner = typeof meta.owner === "string" && meta.owner.trim() ? meta.owner.trim() : UNKNOWN_SCOPE;
    const fleet = typeof meta.fleet === "string" && meta.fleet.trim() ? meta.fleet.trim() : UNKNOWN_SCOPE;
    return { owner, fleet };
  }

  function chargeScope({ owner, fleet }, model, tier, tokens) {
    const nowMs = now();
    const { start, end } = windowBounds(tier, nowMs);
    const existing = db.prepare(
      `SELECT used, window_end AS windowEnd FROM model_budget_scope
       WHERE owner = ? AND fleet = ? AND model = ? AND tier = ?`
    ).get(owner, fleet, model, tier);
    if (!existing || nowMs >= existing.windowEnd) {
      db.prepare(`
        INSERT INTO model_budget_scope (owner, fleet, model, tier, used, window_start, window_end, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner, fleet, model, tier) DO UPDATE SET
          used = excluded.used, window_start = excluded.window_start,
          window_end = excluded.window_end, updated_at = excluded.updated_at
      `).run(owner, fleet, model, tier, Math.round(tokens), start, end, nowMs);
      return;
    }
    db.prepare(`
      UPDATE model_budget_scope SET used = used + ?, updated_at = ?
      WHERE owner = ? AND fleet = ? AND model = ? AND tier = ?
    `).run(Math.round(tokens), nowMs, owner, fleet, model, tier);
  }

  // 分账报表面：按 owner×fleet 给出各模型三级用量。**只回答"谁用了多少"**，
  // 是否符合额度仍以全局 model_budget 行 + checkBudget 为准。
  function scopeReport({ sinceMs = null } = {}) {
    const nowMs = now();
    const rows = db.prepare(
      `SELECT owner, fleet, model, tier, used, window_start AS windowStart, window_end AS windowEnd
       FROM model_budget_scope
       WHERE window_end > ? AND (? IS NULL OR window_end > ?)
       ORDER BY used DESC, owner, fleet, model, tier`
    ).all(nowMs, sinceMs, sinceMs ?? nowMs);
    return rows.map((r) => ({
      owner: r.owner,
      fleet: r.fleet,
      model: r.model,
      tier: r.tier,
      used: r.used,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
      // "unknown" 是显式的未知归属，不是某个默认舰队；调用方必须原样展示。
      unattributed: r.owner === UNKNOWN_SCOPE || r.fleet === UNKNOWN_SCOPE,
    }));
  }

  // 阈值预警（4.2）：到比例就记一条**窗口幂等**的事件。返回本次是否新建。
  //
  // 放在 checkBudget 里而不是定时器里：checkBudget 是每个回合的前置门，
  // 本就是"最接近真实用量"的采样点；幂等由唯一索引兜住，重复调用不重复记。
  function warnIfNearLimit(model, tier, row) {
    if (!cfg.enabled || !model) return false;
    const ratio = cfg.warnRatio;
    if (!(ratio > 0)) return false;                       // 0/非法 = 关闭
    if (!(row.limitTokens > 0)) return false;
    const utilization = row.used / row.limitTokens;
    if (utilization < ratio) return false;                 // 还没到比例
    // 已经撞墙的由 budget_exhausted_log 负责，预警不重复报同一件事。
    if (row.used >= row.limitTokens) return false;
    const info = db.prepare(`
      INSERT OR IGNORE INTO budget_warning_log
        (model, tier, used, limit_tokens, ratio, window_start, window_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(model, tier, Math.round(row.used), row.limitTokens, ratio,
           row.windowStart, row.windowEnd, now());
    if (info.changes > 0) {
      console.warn(
        `[model-budget] WARN ${model}/${tier} at ${(utilization * 100).toFixed(1)}% of cap ` +
        `(${row.used}/${row.limitTokens}), window ends ${new Date(row.windowEnd).toISOString()}`,
      );
      return true;
    }
    return false;
  }

  // 预警读面：谁在靠近上限、到什么程度。给巡检/看板，不自己发通知。
  function warningLog({ limit = 100 } = {}) {
    return db.prepare(`
      SELECT id, model, tier, used, limit_tokens AS limitTokens, ratio,
             window_start AS windowStart, window_end AS windowEnd, created_at AS createdAt
      FROM budget_warning_log ORDER BY id DESC LIMIT ?
    `).all(limit);
  }

  // 入口检查（daily/monthly）。返回 { allowed, blocked: [{tier, used, limit}] }。
  // single 不在此列——它没有跨回合窗口，检查发生在结算面。
  function checkBudget(model) {
    if (!cfg.enabled || !model) return { allowed: true, blocked: [] };
    const blocked = [];
    for (const tier of ["daily", "monthly"]) {
      const row = rollWindow(model, tier);
      // 预警要在"耗尽判定"之前跑：撞墙那一次由 exhausted 日志负责，预警只管临近。
      try {
        warnIfNearLimit(model, tier, row);
      } catch (e) {
        // degrade-open：预警坏了不许挡住回合（与模块其余入口同纪律）。
        console.warn(`[model-budget] warn failed (degrade open): ${e?.message || e}`);
      }
      if (row.used >= row.limitTokens) blocked.push({ tier, used: row.used, limit: row.limitTokens });
    }
    return { allowed: blocked.length === 0, blocked };
  }

  // 结算面消费：tokens 入 daily/monthly 两窗；超过单次上限 → single 事件
  // 落 log（单次窗口无跨回合状态，事件即审计面）。返回 { consumed, singleExceeded }。
  function consumeBudget(model, tokens, meta = {}) {
    if (!cfg.enabled || !model || !Number.isFinite(tokens) || tokens <= 0) return { consumed: false, singleExceeded: false };
    for (const tier of ["daily", "monthly"]) {
      const row = rollWindow(model, tier);
      db.prepare(`UPDATE model_budget SET used = used + ?, updated_at = ? WHERE model = ? AND tier = ?`)
        .run(Math.round(tokens), now(), model, tier);
      if (row.used + tokens > row.limitTokens) {
        logExhausted(model, tier, row.used + tokens, row.limitTokens, meta);
      }
    }
    // 分账：与全局同一笔、同一窗口口径。失败绝不能挡住扣费/回合
    // （degrade-open 纪律：分账是账务，不是闸门）。
    try {
      const { owner, fleet } = scopeKey(meta);
      for (const tier of ["daily", "monthly"]) chargeScope({ owner, fleet }, model, tier, tokens);
    } catch (e) {
      console.warn(`[model-budget] scope charge failed (degrade open): ${e?.message || e}`);
    }
    const singleExceeded = tokens > tierLimit.single;
    if (singleExceeded) logExhausted(model, "single", tokens, tierLimit.single, meta);
    return { consumed: true, singleExceeded };
  }

  // 显式重置（cron job 面）：把对应窗口整体滚到当前窗（used 归零）。返回
  // 实际滚动行数。
  function resetWindow(tier) {
    const nowMs = now();
    const rows = db.prepare(`SELECT model FROM model_budget WHERE tier = ? AND window_end <= ?`).all(tier, nowMs);
    for (const r of rows) rollWindow(r.model, tier);
    return rows.length;
  }
  const resetDaily = () => resetWindow("daily");
  const resetMonthly = () => resetWindow("monthly");

  // 报表面：各模型三级 used/limit/利用率 + 超限事件计数（可按 since 过滤）。
  function report({ sinceDays = 1 } = {}) {
    const since = now() - sinceDays * DAY_MS;
    const rows = db.prepare(`SELECT model, tier, used, limit_tokens AS limitTokens, window_start AS windowStart, window_end AS windowEnd FROM model_budget ORDER BY model, tier`).all();
    const events = db
      .prepare(`SELECT tier, COUNT(*) AS n FROM budget_exhausted_log WHERE created_at >= ? GROUP BY tier`)
      .all(since);
    const eventsByTier = Object.fromEntries(events.map((e) => [e.tier, e.n]));
    const models = rows.map((r) => ({
      model: r.model,
      tier: r.tier,
      used: r.used,
      limit: r.limitTokens,
      utilization: r.limitTokens > 0 ? Math.min(1, r.used / r.limitTokens) : null,
      windowStart: r.windowStart,
      windowEnd: r.windowEnd,
    }));
    return { generatedAt: now(), enabled: cfg.enabled, models, exhaustedEvents: eventsByTier };
  }

  // 超限事件审计读面（spec：超限事件 SHALL 可从 budget_exhausted_log 审计）。
  function exhaustedLog({ limit = 100 } = {}) {
    return db
      .prepare(`SELECT id, model, tier, used, limit_tokens AS limitTokens, job_id AS jobId, session_id AS sessionId, created_at AS createdAt FROM budget_exhausted_log ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }

  return { checkBudget, consumeBudget, resetDaily, resetMonthly, report, exhaustedLog, scopeReport, warningLog, config: cfg };
}

// Boot wiring（fleet-cost-digest 同款纪律）：60s 检查器——UTC 日/月界翻页
// 时显式滚窗，01:00 UTC 产出当日预算利用率日报（console 结构化行）。全部
// degrade-open：引擎坏了只留 warn，绝不抛进平台启动路径。
export function attachModelBudgetReset({ engine, captureFact = null, intervalMs = 60_000, now = () => Date.now() } = {}) {
  let lastDay = utcDayKey(now());
  let lastMonth = utcMonthKey(now());
  let lastReportDay = null;
  const tick = () => {
    try {
      const d = utcDayKey(now());
      const m = utcMonthKey(now());
      if (d !== lastDay) {
        engine.resetDaily();
        lastDay = d;
        // 日报：每日 01:00 UTC 语义由「新 UTC 日第一次 tick」承载——重置与
        // 报表同拍，断网恢复也不会漏跑（懒滚窗兜底在检查/消费两侧）。
        if (d !== lastReportDay) {
          lastReportDay = d;
          const r = engine.report({ sinceDays: 1 });
          // `hot` 原判据是"有耗尽事件 或 利用率≥80%"。上限被抬到 200 亿后前一条几乎
          // 永不成立、后一条也够不到，日报于是变成"模型数 + 空数组"，看不出趋势。
          // 补一条**用量 Top**：日报永远给出当日用最多的几个，不依赖是否接近上限。
          const hot = r.models.filter((x) => (r.exhaustedEvents[x.tier] ?? 0) > 0 || (x.utilization ?? 0) >= 0.8);
          const top = [...r.models]
            .filter((x) => x.used > 0)
            .sort((a, b) => b.used - a.used)
            .slice(0, 3)
            .map((x) => `${x.model}/${x.tier}=${x.used}(${((x.utilization ?? 0) * 100).toFixed(2)}%)`);
          let warnings = [];
          try {
            warnings = engine.warningLog({ limit: 20 });
          } catch { /* 预警读面坏了不影响日报 */ }
          console.log(`[model-budget] daily report ${d}: models=${r.models.length} exhausted=${JSON.stringify(r.exhaustedEvents)} hot=[${hot.map((x) => `${x.model}/${x.tier}/${(x.utilization * 100).toFixed(0)}%`).join(", ")}] top=[${top.join(", ")}] warnings=${warnings.length}`);
          if (typeof captureFact === "function") {
            try {
              captureFact(r, hot);
            } catch { /* fact capture never surfaces */ }
          }
        }
      }
      if (m !== lastMonth) {
        engine.resetMonthly();
        lastMonth = m;
      }
    } catch (e) {
      console.warn(`[model-budget] reset tick failed (degrade open): ${e?.message || e}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { tick, timer };
}

// 等待辅助：给 e2e（跨日界恢复）一个可控时钟推进口——生产不用。
export async function budgetTestSleep(ms) {
  await delay(ms);
}
