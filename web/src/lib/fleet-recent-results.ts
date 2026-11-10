// Recent turn outcomes ring (fleet-ops-canvas): pure helpers shared by the
// live store and the unit test. The ring keeps the newest few turn outcomes
// so the particle overlay can derive "just finished, failed → red" without
// any timer state. Pruning is by both cardinality and age, on every write.

export interface TurnResultEntry {
  turnId: string;
  fleetId: string;
  memberId: string;
  parentMemberId: string | null;
  edgeKind: string | null;
  status: string;
  errorKind: string | null;
  endedAt: number;
}

export const RECENT_RESULTS_MAX = 40;
export const RECENT_RESULTS_TTL_MS = 60_000;

export function pruneResults(
  map: Record<string, TurnResultEntry>,
  now: number,
  { max = RECENT_RESULTS_MAX, ttlMs = RECENT_RESULTS_TTL_MS }: { max?: number; ttlMs?: number } = {},
): Record<string, TurnResultEntry> {
  const entries = Object.values(map)
    .filter((r) => Number.isFinite(r.endedAt) && now - r.endedAt <= ttlMs)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, max);
  if (entries.length === Object.keys(map).length) return map;
  const out: Record<string, TurnResultEntry> = {};
  for (const r of entries) out[r.turnId] = r;
  return out;
}

export function recordResult(
  map: Record<string, TurnResultEntry>,
  entry: TurnResultEntry,
): Record<string, TurnResultEntry> {
  return pruneResults({ ...map, [entry.turnId]: entry }, entry.endedAt);
}