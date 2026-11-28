// cron-session-metrics.mjs — 会话轮换/上下文累积的**纯函数**读数（无 IO、无依赖）。
//
// 为什么要有它（2026-11-16）：`rotate-cron-session-on-context-pressure` 的 5.2「生产复验」
// 被反复复核了三次，每次都靠手敲 `node -e` 现算，算完就丢在 /tmp ——于是同一个问题
// （「轮换到底在防什么、它防的事有没有人口」）每次都要重新考古一遍，而中间两次的结论
// 都是错的（先是把 86% 的 `lastFailed` 归因读成「溢出补救」，后是拿工作树当正本读）。
// 判据要有可复跑的载体，否则「这个数我量过」只活在某次会话里。
//
// 三件必须一起报的量（只报其中一个都会得出相反结论）：
//   ① **会话长度分布** —— 每个 session 有几个 cron 回合。中位 1 轮的分布里，任何「防累积」
//      的机制都无事可做；
//   ② **会话内累积斜率** —— (末轮 - 首轮) / (轮数 - 1)。中位 +197 token/轮意味着 prompt
//      不是逐轮涨上去的，涨也涨不到窗口；
//   ③ **到线人口** —— 多轮会话里峰值真的碰到阈值/窗口的有几个。这是「有没有人口」的直接答案，
//      比任何均值都硬。
//
// 口径（别改，改了数字就不可比）：
//   - 高水位取 `member_turn_events.usage_input_max`（= 该回合出现过的最大 prompt，
//     与 `contextWindow` 可比的量）。`usage_input` / `usage_cached_input` 是**单步**分量，
//     拿它们相加当 prompt 是 2026-11-10「每轮都轮换」的成因；
//   - 时间一律按 `started_at`（**epoch 毫秒整数**）。拿 ISO 字符串比 `>=` 会因首个字符
//     '1' < '2' 把行全滤掉，读成「零回合」；
//   - 轮换归因按**三条**路径分开数（上一轮失败 / 上一轮溢出 / 阈值），合成一个「轮换次数」
//     会把「失败后补救」读成「防溢出」——这两件事的处置方向相反。
//
// 本模块**不出红绿**：它量的是人口与斜率，判定归 change 的解锁条件。常年红的闸等于没有闸。

/** 分位数（f∈[0,1]）。空数组返回 null——**不许把「没样本」读成 0**。 */
export function quantile(values, f) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.floor(f * xs.length)));
  return xs[idx];
}

/**
 * 把回合行按 session 分组，组内按 `started_at` 升序。
 * 输入行形状：`{ sid, at, mx }`（sid = `member_turn_events.session_id`；at = epoch ms；mx = 高水位）。
 * `mx` 非正/非数的行丢弃：那是「没量到」，不是「占用 0」。
 */
export function sessionize(rows) {
  const bySid = new Map();
  for (const r of rows) {
    if (!r || typeof r.sid !== "string" || !r.sid) continue;
    if (typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
    if (typeof r.mx !== "number" || !Number.isFinite(r.mx) || r.mx <= 0) continue;
    if (!bySid.has(r.sid)) bySid.set(r.sid, []);
    bySid.get(r.sid).push(r);
  }
  const out = [];
  for (const [sid, list] of bySid) {
    list.sort((a, b) => a.at - b.at);
    out.push({ sid, rounds: list.length, list });
  }
  out.sort((a, b) => a.list[0].at - b.list[0].at);
  return out;
}

/** 会话长度分布 + 分布直方（1 轮 / 2-3 / 4-6 / 7-12 / >12）。 */
export function sessionLengthStats(sessions) {
  const lens = sessions.map((s) => s.rounds);
  const histogram = { "1 轮": 0, "2-3 轮": 0, "4-6 轮": 0, "7-12 轮": 0, ">12 轮": 0 };
  for (const n of lens) {
    if (n === 1) histogram["1 轮"] += 1;
    else if (n <= 3) histogram["2-3 轮"] += 1;
    else if (n <= 6) histogram["4-6 轮"] += 1;
    else if (n <= 12) histogram["7-12 轮"] += 1;
    else histogram[">12 轮"] += 1;
  }
  return {
    sessions: lens.length,
    singleRound: histogram["1 轮"],
    p50: quantile(lens, 0.5),
    p90: quantile(lens, 0.9),
    max: lens.length ? Math.max(...lens) : null,
    histogram,
  };
}

/**
 * 会话内累积斜率：(末轮 - 首轮) / (轮数 - 1)，只收 ≥`minRounds` 轮的会话。
 * **允许为负**：一半的会话里 prompt 是逐轮变小的，把负数抹成 0 会让「不累积」看起来像
 * 「缓慢累积」，而这两者对轮换的结论相反。
 */
export function accumulationSlopes(sessions, { minRounds = 2 } = {}) {
  const out = [];
  for (const s of sessions) {
    if (s.rounds < minRounds) continue;
    const first = s.list[0].mx;
    const last = s.list[s.list.length - 1].mx;
    out.push({ sid: s.sid, rounds: s.rounds, first, last, slope: (last - first) / (s.rounds - 1) });
  }
  return out;
}

/**
 * 「到线人口」：多轮会话里峰值碰到 `threshold`（轮换闸的门槛）与 `window`（窗口）的个数。
 * 分母**只算多轮会话**——单轮会话没有累积可言，把它们算进分母会把占比稀释成看起来没事。
 */
export function peakReach(sessions, { threshold, window, minRounds = 2 } = {}) {
  let considered = 0;
  let reachedThreshold = 0;
  let reachedWindow = 0;
  for (const s of sessions) {
    if (s.rounds < minRounds) continue;
    considered += 1;
    const peak = Math.max(...s.list.map((r) => r.mx));
    if (typeof threshold === "number" && peak >= threshold) reachedThreshold += 1;
    if (typeof window === "number" && peak >= window) reachedWindow += 1;
  }
  return { considered, reachedThreshold, reachedWindow };
}

/** 单轮高水位的分布（说明「大 prompt 是单轮体量」还是「累积」）。 */
export function roundHighWaterStats(rows) {
  const xs = rows.filter((r) => typeof r.mx === "number" && Number.isFinite(r.mx) && r.mx > 0).map((r) => r.mx);
  return {
    rounds: xs.length,
    p50: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    p99: quantile(xs, 0.99),
    max: xs.length ? Math.max(...xs) : null,
  };
}

// 与 task-engine 的 `isContextOverflowError` 同一套措辞（provider 文案，不是本地预检）。
const CONTEXT_OVERFLOW_RE =
  /CONTEXT_WINDOW_EXCEEDED|context overflow|context window exceeded|maximum context length|too large for (?:this|the) model/i;

/** 与 `shouldRotateSession` 同口径：从末尾找第一条带 tokens 的行，`cacheRead + input >= threshold`。 */
export function thresholdWouldRotate(history, threshold) {
  if (!Array.isArray(history)) return false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const tokens = history[i]?.tokens;
    if (!tokens) continue;
    const used = (Number(tokens.cacheReadTokens) || 0) + (Number(tokens.inputTokens) || 0);
    if (used <= 0) return false;
    return used >= threshold;
  }
  return false;
}

/**
 * 轮换归因。**三条路径分开数**（在役 `task-engine.js` 的判定是
 * `overflowAsked || lastFailed || shouldRotateSession`）：
 *
 *   lastFailed  上一轮失败（success !== true）且错误**不是**上下文溢出 ⇒ 失败后补救
 *   overflow    上一轮失败且错误命中溢出文案 ⇒ `rotateNextSession` 那条
 *   threshold   上一轮成功、且闸判要换 ⇒ 真的「上下文压力」
 *   residue     上一轮成功、闸说不换，却仍轮换了 ⇒ 事后数据解释不了，**要报出来别吞**
 *   firstRow    该 job 的首个执行行就带轮换标记 ⇒ 没有「上一轮」可比
 *
 * 只数 `kind === "execution"` 的行：`missed` / `skipped` 不是回合，它们没有轮换语义。
 */
export function rotationAttribution(tasks, threshold) {
  const counts = { lastFailed: 0, overflow: 0, threshold: 0, residue: 0, firstRow: 0 };
  let executedRows = 0;
  let rotatedRows = 0;
  const examples = { residue: [] };
  for (const t of tasks || []) {
    const history = Array.isArray(t?.history) ? t.history : [];
    let seenExecution = false;
    for (let i = 0; i < history.length; i += 1) {
      const row = history[i];
      if (row?.kind !== "execution") continue;
      executedRows += 1;
      if (!row.sessionRotated) {
        seenExecution = true;
        continue;
      }
      rotatedRows += 1;
      if (!seenExecution) {
        counts.firstRow += 1;
        seenExecution = true;
        continue;
      }
      // 上一条执行行（不是上一条行——missed 行夹在中间不参与判定，但 task-engine 看的是
      // `history[last]`，所以这里也按「最近一条 execution」对齐，并在注释里写明差异）
      let prev = null;
      for (let k = i - 1; k >= 0; k -= 1) {
        if (history[k]?.kind === "execution") {
          prev = history[k];
          break;
        }
      }
      if (!prev) {
        counts.firstRow += 1;
      } else if (prev.success !== true) {
        if (CONTEXT_OVERFLOW_RE.test(String(prev.error || ""))) counts.overflow += 1;
        else counts.lastFailed += 1;
      } else if (thresholdWouldRotate(history.slice(0, i), threshold)) {
        counts.threshold += 1;
      } else {
        counts.residue += 1;
        if (examples.residue.length < 5) examples.residue.push(String(t?.id || "?"));
      }
      seenExecution = true;
    }
  }
  return { counts, executedRows, rotatedRows, examples };
}

/** 轮换率：`sessionRotated` 的执行行 / 全部执行行。分母是**执行行**，不是任务数。 */
export function rotationRate(tasks) {
  let executed = 0;
  let rotated = 0;
  for (const t of tasks || []) {
    for (const row of t?.history || []) {
      if (row?.kind !== "execution") continue;
      executed += 1;
      if (row.sessionRotated) rotated += 1;
    }
  }
  return { executed, rotated, rate: executed ? rotated / executed : null };
}
