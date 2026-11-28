// The scheduled-task list a caller actually needs (fix-cron-list-scope).
//
// Measured on the deployment: one cell held **816 tasks, 658 of them fleet
// materializations** (a cadence per post). `cron_list` shipped every one as a
// line — 112KB per call, the largest single tool result on the fleet — and 80%
// of it was posts' cadence rows that the fleet surface (`fleet_list` /
// `fleet_spec_read`) already owns.
//
// So the list is scoped, paged, and always says what it left out:
//   scope=user  (default) — the operator's own tasks: what "my scheduled tasks"
//                means, and what this tool is for;
//   scope=fleet           — only fleet materializations (troubleshooting a post's
//                cadence without the rest of the noise);
//   scope=all             — both, for an audit.
// Nothing is hidden silently: the header always states the totals and the scope.
//
// Pure and exported so it has a test face (the MCP module spawns a stdio server
// at import and cannot be imported by a test).

export const CRON_LIST_LIMIT = 30;
export const CRON_LIST_MAX = 200;
export const CRON_SCOPES = ["user", "fleet", "all"];

import { HISTORY_KIND, classifyHistoryEntry } from "./history-kinds.js";

export function isFleetTask(job) {
  return Boolean(job?.sourceTag?.fleetId);
}

// What the LAST history row actually says, in the caller's vocabulary.
//
// The list used to print `last: ${row.success ? "ok" : "failed: …"}` — a two-way
// split over a field with three lawful shapes. `{success:null, missed:N}` means
// "the schedule came due and nothing ever ran"; it rendered as `failed: ?`, and
// so did a calibration note. That is the exact misread `server/history-kinds.js`
// was written to end (its header measures a 89.7% false-failure rate from it),
// resurfacing on the MCP surface — where an agent reads it and goes hunting for
// a fault that does not exist. Dispatch on the kind; never on the shape.
export function lastOutcomeLabel(row) {
  const kind = classifyHistoryEntry(row);
  if (!row || kind === HISTORY_KIND.META || kind === HISTORY_KIND.QUEUED_UPGRADE) return null;
  if (kind === HISTORY_KIND.MISSED) {
    const n = Number(row.missed) || 0;
    return n > 0 ? `missed ×${n} (due, never started)` : "missed (due, never started)";
  }
  if (kind === HISTORY_KIND.SUPERSEDED) return "superseded by a newer round";
  return row.success === true ? "ok" : `failed: ${row.error || "?"}`;
}

// 本轮会话占窗口多少（expose-cron-session-occupancy）。
//
// 两个数都是运行时量出来的，且都由 `task-engine.js` 的**同一个写入方**落在历史行上：
// `promptTokens` 是该回合出现过的最大 prompt（input + cacheRead 的高水位），
// `promptWindow` 是 `request/context` 解析出的真窗口。
// 缺一就没有比例——**返回 null 而不是 0**：`0` 会被读成「空会话」，而真相是「不知道」。
//
// 为什么读 `promptWindow` 而不是 `contextUsage.contextWindow`（2026-11-16 合并时的决定）：
// 后者是轮换闸的口径，运行时没报窗口时**会回落到部署常量**（那是闸该做的事——分母不能空）。
// 但读面要回答的是「这一轮的真实窗口是多少」，回落到常量就成了假事实：「未知」与「拿 128000
// 除出来的 43%」会混成同一个数。`promptWindow` 只在运行时真的报了才写，缺席即未知。
// **同一个量不许两个名字**：我原先在这里写作 `contextWindow`，而另一条线
// （`fix-context-attribution-window`）已经把同一个量写成 `promptWindow` 并让闸读它——
// 合并时统一到后者，历史行上只留一个键。
//
// `typeof !== "number"` 必须走在 `Number.isFinite` 前面：`Number(null) === 0` 会让
// 「没有这个字段」算出一个 0%（本仓已经在这条上栽过，见 history-kinds 的 89.7%）。
export function sessionOccupancy(row) {
  const prompt = row?.promptTokens;
  const window = row?.promptWindow;
  if (typeof prompt !== "number" || typeof window !== "number") return null;
  if (!Number.isFinite(prompt) || !Number.isFinite(window)) return null;
  if (window <= 0 || prompt <= 0) return null;
  return { promptTokens: prompt, contextWindow: window, ratio: prompt / window };
}

// `session 83% of 128000`。取整向下：99.6% 显示成 100% 会让人以为已经爆了。
// 不可得返回 null（调用方必须让它整段不出现，而不是打一个占位符）。
export function sessionOccupancyLabel(row) {
  const occ = sessionOccupancy(row);
  if (!occ) return null;
  return `session ${Math.floor(occ.ratio * 100)}% of ${occ.contextWindow}`;
}

export function shapeCronList(jobs = [], { scope = "user", limit = null, offset = 0 } = {}) {
  const all = Array.isArray(jobs) ? jobs : [];
  const fleet = all.filter(isFleetTask);
  const user = all.filter((j) => !isFleetTask(j));
  const pool = scope === "fleet" ? fleet : scope === "all" ? all : user;

  const requested = Number(limit);
  const cap = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), CRON_LIST_MAX) : CRON_LIST_LIMIT;
  const start = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
  const page = pool.slice(start, start + cap);

  // The header carries the accounting in every case, so a scoped or paged view
  // can never read as "this is everything".
  const parts = [`${pool.length} task(s) in scope=${scope}`];
  if (scope !== "all") parts.push(`${all.length} total: ${user.length} operator, ${fleet.length} fleet-materialized`);
  else parts.push(`${user.length} operator, ${fleet.length} fleet-materialized`);
  const range = page.length ? `${start + 1}-${start + page.length} of ${pool.length}` : `none of ${pool.length}`;
  const truncated = start + page.length < pool.length;
  return {
    jobs: page,
    total: pool.length,
    allTotal: all.length,
    userTotal: user.length,
    fleetTotal: fleet.length,
    offset: start,
    limit: cap,
    truncated,
    header: `${parts.join(" · ")} — showing ${range}${truncated ? ` (next offset ${start + page.length})` : ""}.`,
  };
}
