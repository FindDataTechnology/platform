// ── Fleet cost weekly digest (add-fleet-memory-anchors 补丁4) ─────────────────
//
// The metering axis feeding the memory axis: one "舰队成本周报" fact page per
// active fleet per ISO week, written into the fleet's `f/` project via the
// SAME capture lane as the five fact kinds (degrade open — memory缺席零影响).
// Content: per-member turns/ok/failed, estimated cost (priced-sample口径 from
// the daily rollup's cost columns), queue-wait概貌, and HONEST movers (cost
// ×2 week-over-week or queue-wait +50%). A pure L1 text page — fuel for the
// L2 distiller, never a bill (estimates stay estimates).
//
// Weekly boundary: UTC ISO week (Monday 00:00). The sweep runs on a timer and
// keeps an in-memory lastWeekByFleet book — a restart may rewrite one page
// (memory pages are never deleted; a duplicate weekly page is harmless and
// honest).

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function isoWeekKey(date = new Date()) {
  // Monday-anchored UTC week: YYYY-Www
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // 1..7, Monday=1
  d.setUTCDate(d.getUTCDate() - (day - 1));
  const week1Mon = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const w1day = week1Mon.getUTCDay() || 7;
  week1Mon.setUTCDate(week1Mon.getUTCDate() - (w1day - 1));
  const week = 1 + Math.round((d.getTime() - week1Mon.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function prevWeekKey(key) {
  const [y, w] = key.split("-W").map(Number);
  const d = new Date(Date.UTC(y, 0, 4));
  const w1day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (w1day - 1) + (w - 2) * 7);
  return isoWeekKey(d);
}

// Aggregate one fleet's daily rows for one week key. Pure — exported for tests.
export function aggregateWeek(rows, weekKey) {
  const out = new Map();
  for (const r of rows) {
    if (!weekKey || r.day < weekMonday(weekKey) || r.day >= weekMonday(nextWeekKey(weekKey))) continue;
    const key = r.member_id;
    const cur = out.get(key) ?? { memberId: key, model: r.model, turns: 0, ok: 0, failed: 0, costUsd: 0, pricedTurns: 0, queueWaitSum: 0, queueWaitMax: 0 };
    cur.turns += r.turns ?? 0;
    cur.ok += r.ok_count ?? 0;
    cur.failed += r.failed_count ?? 0;
    cur.costUsd += (r.cost_input_usd ?? 0) + (r.cost_output_usd ?? 0) + (r.cost_cache_write_usd ?? 0) + (r.cost_cache_read_usd ?? 0);
    if (r.pricing_at != null) cur.pricedTurns += r.turns ?? 0;
    cur.queueWaitSum += r.queue_wait_ms_sum ?? 0;
    cur.queueWaitMax = Math.max(cur.queueWaitMax, r.queue_wait_ms_max ?? 0);
    out.set(key, cur);
  }
  return [...out.values()].sort((a, b) => b.costUsd - a.costUsd);
}

function weekMonday(key) {
  const [y, w] = key.split("-W").map(Number);
  const d = new Date(Date.UTC(y, 0, 4));
  const w1day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (w1day - 1) + (w - 1) * 7);
  return d.toISOString().slice(0, 10);
}
function nextWeekKey(key) {
  const [y, w] = key.split("-W").map(Number);
  const d = new Date(Date.UTC(y, 0, 4));
  const w1day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (w1day - 1) + w * 7);
  return isoWeekKey(d);
}

// The movers line (pure — exported for tests): honest week-over-week. Cost
// mover = this week ≥2× last week AND ≥$0.001 (noise floor); wait mover =
// max queue-wait ≥+50% AND this week ≥30s. "无对照" when last week is empty.
export function moversLine(thisWeek, lastWeek) {
  if (!lastWeek.length) return "movers：无对照（上周无样本）";
  const last = new Map(lastWeek.map((r) => [r.memberId, r]));
  const lines = [];
  for (const cur of thisWeek) {
    const prev = last.get(cur.memberId);
    if (!prev) continue;
    if (prev.costUsd > 0 && cur.costUsd >= 0.001 && cur.costUsd >= prev.costUsd * 2) {
      lines.push(`${cur.memberId} 成本 $${prev.costUsd.toFixed(4)}→$${cur.costUsd.toFixed(4)}（×${(cur.costUsd / prev.costUsd).toFixed(1)}）`);
    }
    if (prev.queueWaitMax > 0 && cur.queueWaitMax >= 30_000 && cur.queueWaitMax >= prev.queueWaitMax * 1.5) {
      lines.push(`${cur.memberId} 排队等待 max ${(prev.queueWaitMax / 1000).toFixed(0)}s→${(cur.queueWaitMax / 1000).toFixed(0)}s`);
    }
  }
  return lines.length ? `movers：${lines.join("；")}` : "movers：无（周环比平稳）";
}

// Build the page body (pure — exported for tests). Top 12 members by cost.
export function buildWeeklyBody(thisWeek, lastWeek, { weekKey }) {
  const lines = [`周 ${weekKey} · 舰队成本周报（估算口径：有价样本，估算永不混入计费真数）`];
  if (!thisWeek.length) {
    lines.push("无样本：本周该舰队没有回合记录。");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("| 成员 | 回合 | ok/failed | 估算成本 | 排队 max |");
  lines.push("|---|---|---|---|---|");
  for (const r of thisWeek.slice(0, 12)) {
    const wait = r.queueWaitMax > 0 ? `${(r.queueWaitMax / 1000).toFixed(0)}s` : "—";
    lines.push(`| ${r.memberId} | ${r.turns} | ${r.ok}/${r.failed} | $${r.costUsd.toFixed(4)}${r.pricedTurns < r.turns ? `（有价 ${r.pricedTurns}/${r.turns}）` : ""} | ${wait} |`);
  }
  lines.push("", moversLine(thisWeek, lastWeek));
  return lines.join("\n");
}

// The carrier-anomaly evaluator (add-agent-self-iteration ②): the FIRST
// memory→proposal bridge. Four conditions ALL hit → a carrier-change proposal
// into the fleet's decision lane: queue-wait max ≥5min, ≥3 distinct days
// above it, ≥6-turn sample, current placement cell/auto. Evidence rides the
// detail (provenance + samples); a human approves — 提议≠生效.
const WAIT_FLOOR_MS = 5 * 60_000;
const DAYS_FLOOR = 3;
const SAMPLE_FLOOR = 6;

// Pure — exported for tests. perMember: [{memberId, turns, queueWaitMax, carrier, hotDays}]
export function carrierAnomalies(perMember, { waitFloorMs = WAIT_FLOOR_MS, daysFloor = DAYS_FLOOR, sampleFloor = SAMPLE_FLOOR } = {}) {
  return perMember.filter(
    (m) =>
      (m.carrier ?? "auto") !== "worker" &&
      (m.carrier ?? "auto") !== "runner" &&
      m.queueWaitMax >= waitFloorMs &&
      m.hotDays >= daysFloor &&
      m.turns >= sampleFloor,
  );
}

async function maybeProposeCarrierChange({ fleet, member, weekKey, propose }) {
  const evidence = {
    proposedBy: "platform:cost-anomaly",
    week: weekKey,
    memberId: member.memberId,
    queueWaitMaxMs: member.queueWaitMax,
    hotDays: member.hotDays,
    sampleTurns: member.turns,
    costEstUsd: Number(member.costUsd.toFixed(4)),
    pricedTurns: member.pricedTurns,
  };
  return propose({
    fleetId: fleet.id,
    changes: { memberId: member.memberId, carrier: "worker" },
    evidence,
    summary: `承载提议 · ${member.memberId} 排队等待持续超阈（周 ${weekKey}，max ${(member.queueWaitMax / 60_000).toFixed(0)}min）→ 建议 worker（前置：TASK_WORKER_MAX>0）`,
  });
}

// The sweep: one page per active fleet whose ISO week hasn't been written yet.
export async function runFleetCostDigests({ fleetsDb, captureFact, listActiveFleets, now = new Date(), written = null, propose = null, memberCarriers = null }) {
  const book = written ?? new Map();
  const weekKey = isoWeekKey(now);
  const prevKey = prevWeekKey(weekKey);
  let writtenCount = 0;
  for (const fleet of listActiveFleets()) {
    if (book.get(fleet.id) === weekKey) continue;
    try {
      const rows = (fleetsDb.db ?? fleetsDb)
        .prepare(
          `SELECT member_id, model, day, turns, ok_count, failed_count,
                  cost_input_usd, cost_output_usd, cost_cache_write_usd, cost_cache_read_usd, pricing_at,
                  queue_wait_ms_sum, queue_wait_ms_max
           FROM member_turn_daily
           WHERE fleet_id = ? AND day >= ?
           ORDER BY day ASC`,
        )
        .all(fleet.id, weekMonday(prevKey));
      const thisWeek = aggregateWeek(rows, weekKey);
      const lastWeek = aggregateWeek(rows, prevKey);
      const body = buildWeeklyBody(thisWeek, lastWeek, { weekKey });
      captureFact(fleet.id, "fleet", "cost-weekly", `舰队成本周报 ${weekKey}`, body);
      book.set(fleet.id, weekKey);
      writtenCount += 1;
      // Carrier anomaly proposals (add-agent-self-iteration): evaluate AFTER
      // the page lands; per-member day-level re-aggregation for the hot-day
      // count (the weekly aggregate collapses days).
      if (typeof propose === "function") {
        const perMember = thisWeek.map((m) => {
          const hotDays = new Set(
            rows
              .filter((r) => r.member_id === m.memberId && (r.queue_wait_ms_max ?? 0) >= WAIT_FLOOR_MS)
              .map((r) => r.day),
          );
          return { ...m, hotDays: hotDays.size, carrier: memberCarriers?.get?.(m.memberId) ?? null };
        });
        const anomalies = carrierAnomalies(perMember);
        for (const a of anomalies) {
          // Dedup: an OPEN carrier-change proposal for the same member skips
          // this week's proposal (the decision lane is the window).
          try {
            const open = (fleetsDb.listDecisions?.({ fleetId: fleet.id, state: "open" }) ?? []).find(
              (x) => x.itemType === "carrier-change" && x.detail?.changes?.memberId === a.memberId,
            );
            if (open) continue;
            await maybeProposeCarrierChange({
              fleet,
              member: a,
              weekKey,
              propose,
            });
          } catch {
            // degrade open: proposal failures never touch the digest or turns
          }
        }
      }
    } catch {
      // degrade open: a broken digest never surfaces anywhere
    }
  }
  return writtenCount;
}

// Boot wiring: the 6h sweep timer. Degrade open — never throws.
export function attachFleetCostDigest({ fleetsDb, captureFact, listActiveFleets, intervalMs = SWEEP_INTERVAL_MS } = {}) {
  const written = new Map();
  const sweep = () => runFleetCostDigests({ fleetsDb, captureFact, listActiveFleets, written }).catch(() => {});
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return { sweep, timer };
}
