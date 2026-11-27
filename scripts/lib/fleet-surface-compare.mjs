// ── JSON equivalence for the fleet-surface comparator ──────────────────────
//
// Both functions here shipped broken in the first draft of
// scripts/capture-fleet-surface.mjs, and both failed SILENTLY — the comparator
// reported "identical" for trees that differed:
//
//   1. `diff` re-passed `out = []` as a default argument on every recursive
//      call, so children's findings landed in a throwaway array. Any two
//      objects compared equal.
//   2. `canonical` sorted and compared raw values, so timestamps (createdAt,
//      sortKey, …) differed on every run and buried the real changes.
//
// A flaky or mute equivalence check is worse than none: it teaches people to
// re-run until green. They live in their own module so
// scripts/test-fleet-surface-comparator.mjs can feed them objects KNOWN to
// differ and objects known to match.

/**
 * Timestamp-valued keys. Two runs of identical code differ on these because the
 * fixture is created fresh each time; comparing them reports the clock.
 */
export const TIME_KEYS = new Set([
  "createdAt", "updatedAt", "sampledAt", "at", "ts", "startedAt", "endedAt",
  "lastFireAt", "nextFireAt", "failingSince", "lastSeenAt", "since", "time", "sortKey",
]);

/**
 * A comparable projection of a JSON value:
 *   - arrays of objects carrying a string `id` are sorted by that id (the list
 *     order is creation-time and the fixture lands inside one millisecond, so
 *     order is run-to-run jitter, not behavior);
 *   - object keys are sorted;
 *   - timestamp-valued keys become "<ts>".
 */
export function canonical(value) {
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    const keyed = items.every((v) => v && typeof v === "object" && typeof v.id === "string");
    return keyed ? [...items].sort((a, b) => a.id.localeCompare(b.id)) : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, TIME_KEYS.has(k) ? "<ts>" : canonical(value[k])]),
    );
  }
  return value;
}

/**
 * Every leaf path where two JSON values differ. Mutates `out` — see the header
 * for why that detail is load-bearing.
 */
export function diff(a, b, at = "", out = []) {
  if (a === b) return out;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) {
    out.push(`${at}: type ${ta} -> ${tb}`);
    return out;
  }
  if (ta === "array") {
    if (a.length !== b.length) out.push(`${at}: length ${a.length} -> ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out);
    return out;
  }
  if (ta === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in a)) out.push(`${at}.${k}: added`);
      else if (!(k in b)) out.push(`${at}.${k}: removed`);
      else diff(a[k], b[k], `${at}.${k}`, out);
    }
    return out;
  }
  out.push(`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return out;
}

/** Compare two already-canonicalised endpoint maps; returns all differences. */
export function compareSurfaces(baseline, current) {
  const failures = [];
  for (const k of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    if (!(k in current)) { failures.push(`${k}: endpoint disappeared`); continue; }
    if (!(k in baseline)) { failures.push(`${k}: endpoint added`); continue; }
    diff(baseline[k], current[k], k, failures);
  }
  return failures;
}
