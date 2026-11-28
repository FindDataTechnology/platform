// ── history[] kinds ──────────────────────────────────────────────────────────
//
// A task's `history[]` is **execution history**, not a notepad. One day of
// misreads produced this list:
//
//   {success:null, missed:1}   到期没跑       -> 读成失败（89.7% 假失败率）
//   {success:null, note:"…"}   校准留痕       -> 读成失败（62.1% vs 真实 38.3%）
//   executionCarrier           瞬时字段       -> 「worker 池没跑过」
//
// Every statistics script wrote its own `cls()` and guessed from the shape, so
// each one guessed differently. Now the writer declares the kind and readers
// dispatch on it. This module is deliberately pure (no fs, no clock, no engine
// import) so a reporting script can classify production records without loading
// the task engine — the engine re-exports these names for in-cell callers.
export const HISTORY_KIND = {
  EXECUTION: "execution",           // 真跑过：state ∈ done/failed/interrupted/skipped
  MISSED: "missed",                 // 到期未执行（从未开始）
  SUPERSEDED: "superseded",         // 被同岗位新一轮顶替
  QUEUED_UPGRADE: "queued-upgrade", // 入队时把 staleness 豁免升级为 human
  META: "meta",                     // 其它元数据（不得计入任何执行统计）
};

const EXECUTION_STATES = new Set(["done", "failed", "interrupted", "skipped"]);

// 读方唯一入口。**新写入的条目靠 kind；旧条目靠形状回退**——两条路都在这里，
// 别在调用方再写一遍 if。
export function classifyHistoryEntry(h) {
  if (!h || typeof h !== "object") return HISTORY_KIND.META;
  if (h.kind && Object.values(HISTORY_KIND).includes(h.kind)) return h.kind;
  if (h.supersededBy) return HISTORY_KIND.SUPERSEDED;
  if (h.state === "queued") return HISTORY_KIND.QUEUED_UPGRADE;
  if (h.success === null && h.missed) return HISTORY_KIND.MISSED;
  // 有 state 才是真执行；没有 state 的（只有 note/时间戳）一律当元数据，
  // 绝不能落进"失败"桶——75 条校准留痕就是这么把 38.3% 变成 62.1% 的。
  if (EXECUTION_STATES.has(h.state)) return HISTORY_KIND.EXECUTION;
  return HISTORY_KIND.META;
}

// 汇总一条记录的 history。执行类只在 EXECUTION 里分流，missed/meta 单独计数，
// 这样"失败率"的分母永远只含真执行过的回合。
//
// 缺口要分两个数报：
//   missed          —— 行数（"有几次加载发现缺口"）
//   missedOccurrences —— 触发点次数之和，这才是饥饿的量级
// 一行 `missed:100` 与一行 `missed:1` 都是"一次记录"，但差 100 倍。
// `missedCapped` 的行是**下界**：写入方一次加载最多数 MAX_MISSED_PER_LOAD 个
// 触发点（防止数月不跑的 job 把解析器转爆），碰到上限就只记到上限。
// 单独数出来，读方才不会把「≥100」当成「正好 100」。
export function summarizeHistory(entries) {
  const out = {
    done: 0, failed: 0, skipped: 0, interrupted: 0,
    missed: 0, missedOccurrences: 0, missedCapped: 0, superseded: 0, meta: 0,
  };
  for (const h of entries || []) {
    switch (classifyHistoryEntry(h)) {
      case HISTORY_KIND.MISSED:
        out.missed += 1;
        out.missedOccurrences += Number(h.missed) || 0;
        if (h.missedCapped) out.missedCapped += 1;
        break;
      case HISTORY_KIND.SUPERSEDED: out.superseded += 1; break;
      case HISTORY_KIND.QUEUED_UPGRADE:
      case HISTORY_KIND.META: out.meta += 1; break;
      default: {
        const st = h?.state;
        if (st === "done") out.done += 1;
        else if (st === "failed") out.failed += 1;
        else if (st === "skipped") out.skipped += 1;
        else if (st === "interrupted") out.interrupted += 1;
        else out.meta += 1;
      }
    }
  }
  out.executed = out.done + out.failed + out.skipped + out.interrupted;
  out.failureRate = out.executed > 0 ? out.failed / out.executed : null;
  // 排队饥饿的硬指标：到期没跑的**次数** / 真跑过的回合数。missedCapped>0 时
  // 这个比值是下界（真值只会更大）。executed=0 时无意义，返回 null 而不是 Infinity。
  out.starvationRatio = out.executed > 0 ? out.missedOccurrences / out.executed : null;
  return out;
}
