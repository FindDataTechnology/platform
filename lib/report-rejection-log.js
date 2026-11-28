// ── Report-rejection rolling log (fix-fleet-report-delivery 3.1/3.2) ────────
//
// The flood gate can refuse a whole report, and until 2026-11-09 the only
// witness was a 429 in a tool result the model saw — the operator had no way to
// learn that a post's reports were being dropped. That specific blindness cost
// a full forensic detour (see fix-fleet-report-delivery/reports).
//
// This module keeps the operator-facing count: a bounded, windowed list of
// refusals, pruned on every write AND on every read so a quiet post's history
// ages out without needing a sweeper. In-memory by design — a rejection is an
// operational signal about NOW, not a durable ledger row, and adding a table
// for it would be a schema change this defect does not justify.

const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000; // matches the daily-cadence flood window
const MAX_ENTRIES = 500;

/**
 * Append one rejection and drop everything older than the window.
 * Mutates and returns the same array (callers hold one reference).
 *
 * @param {Array<{memberId: string, at: number}>} log
 * @param {{ memberId: string, at?: number }} entry
 * @param {{ now?: number, windowMs?: number }} [opts]
 */
export function recordRejection(log, entry, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Array.isArray(log)) return [];
  const memberId = entry && typeof entry.memberId === "string" ? entry.memberId : "";
  if (!memberId) return log;
  const at = Number.isFinite(entry.at) ? entry.at : now;
  log.push({ memberId, at });
  prune(log, { now, windowMs });
  return log;
}

/** Drop entries outside the window and cap the list length. */
export function prune(log, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Array.isArray(log)) return [];
  const floor = now - windowMs;
  let i = 0;
  while (i < log.length && log[i].at < floor) i += 1;
  if (i > 0) log.splice(0, i);
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  return log;
}

/**
 * Operator-facing view: how many refusals in the window, per post, and when the
 * window last saw one. Counts only what the log actually holds — an absent post
 * is absent, never zero-padded.
 */
export function summarizeRejections(log, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Array.isArray(log)) return { windowMs, total: 0, byMember: {} };
  const floor = now - windowMs;
  const byMember = {};
  let total = 0;
  for (const row of log) {
    if (!row || typeof row.memberId !== "string" || !row.memberId) continue;
    if (!(row.at >= floor)) continue;
    total += 1;
    const slot = byMember[row.memberId] ?? { count: 0, lastAt: 0 };
    slot.count += 1;
    if (row.at > slot.lastAt) slot.lastAt = row.at;
    byMember[row.memberId] = slot;
  }
  return { windowMs, total, byMember };
}

export { DEFAULT_WINDOW_MS };
