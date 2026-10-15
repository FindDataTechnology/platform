// server/usage-telemetry.js — per-turn pack usage rows for supply feedback.
//
// The marketplace's M1 feedback lane (add-pack-usage-telemetry): every
// completed turn lands one row in the main app db (`pack_usage_events`,
// migration 24) so "which pack did whom use, how many turns" is answerable —
// the weekly-active-pack gate and the next-vertical content decisions both
// read from here. Everything is failure-isolated (trace.js discipline): a
// telemetry failure logs and never breaks the chat turn.
//
// Storage is bounded by a RECURRING prune (not boot-only — the 2026-10-10
// trace incident taught that lesson): rows older than the retention window
// (default 180 days) go on a daily timer, and the db runs
// auto_vacuum=INCREMENTAL so pruned volume actually returns to the fs.

import { getDb, isDbReady } from "../db.js";
import { getChatAgentEntries } from "../catalog.js";

const RETENTION_DAYS = Number(process.env.PACK_USAGE_RETENTION_DAYS) || 180;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let pruneTimer = null;

// Record one completed turn. Resolves the pack origin from the catalog at
// record time; local personas and custom presets (no catalog entry — or an
// entry with no packId) record NULL rather than dropping the row — losing the
// dimension is acceptable, losing the fact is not.
export function recordPackUsage({ userEmail, sessionId, agentId, outcome, durationMs, startedAt }) {
  try {
    if (!isDbReady()) return;
    let packId = null;
    if (agentId && agentId !== "local") {
      const entry = getChatAgentEntries().find((e) => e.id === agentId);
      packId = entry?.packId ?? null;
    }
    const duration = Number.isFinite(startedAt)
      ? Math.max(0, Date.now() - startedAt)
      : Math.max(0, Number(durationMs) || 0);
    getDb()
      .prepare(
        `INSERT INTO pack_usage_events (ts, user_email, session_id, agent_id, pack_id, outcome, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), userEmail ?? null, String(sessionId ?? ""), String(agentId ?? "local"), packId, String(outcome ?? "ok"), duration);
  } catch (e) {
    console.warn(`[usage-telemetry] record failed (turn unaffected): ${e?.message || e}`);
  }
}

// Prune rows past the retention window. Exported for tests; the recurring
// timer in startUsagePruneTimer is what keeps a long-resident cell bounded.
export function prunePackUsage() {
  try {
    if (!isDbReady()) return 0;
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    const r = getDb().prepare(`DELETE FROM pack_usage_events WHERE ts < ?`).run(cutoff);
    return r.changes;
  } catch (e) {
    console.warn(`[usage-telemetry] prune failed: ${e?.message || e}`);
    return 0;
  }
}

export function startUsagePruneTimer() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => prunePackUsage(), PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
}

// Aggregate per pack origin over the window (default 7 days — the
// weekly-active gate): turns, distinct active users, last-used. The packless
// bucket (local / custom presets) is its own line and never inflates a pack.
export function packUsageAggregate(days = 7) {
  const windowDays = Math.min(Math.max(Number(days) || 7, 1), 365);
  const since = Date.now() - windowDays * 86_400_000;
  const rows = getDb()
    .prepare(
      `SELECT pack_id AS packId,
          COUNT(*) AS turns,
          COUNT(DISTINCT user_email) AS activeUsers,
          MAX(ts) AS lastUsedAt
       FROM pack_usage_events
       WHERE ts >= ?
       GROUP BY pack_id
       ORDER BY turns DESC`,
    )
    .all(since);
  const weeklyActivePacks = rows.filter((r) => r.packId && r.activeUsers >= 1).length;
  return { windowDays, weeklyActivePacks, rows };
}
