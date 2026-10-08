// ── Deployment bookkeeping snapshot cache (add-wanxing-deployments-cache) ────
//
// The hot-path fix for the facade's slug resolution and catalog: one cached
// snapshot of the packs internal API's deployment list (TTL + single-flight +
// serve-stale), indexed by slug for O(1) resolution — instead of a full
// bookkeeping fetch + linear scan on every external turn.
//
// diffDeployments is the load-bearing export beyond this repo: the fleet
// observer's bookkeeping-change detector (fd-wanxing program slice ③,
// add-fleet-event-backbone) reuses this exact pure function by minimal copy;
// the facade extraction (slice ②) converges the two into one. Keep it pure
// and dependency-light (slugFor only).

import { slugFor } from "./core.js";

// Canonical JSON so row comparisons don't depend on key order.
const canonical = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
};

// Pure diff over bookkeeping rows, keyed by agentPath (the deployment
// identity). Unchanged refreshes report all three buckets empty.
export function diffDeployments(prev = [], next = []) {
  const prevMap = new Map(prev.map((r) => [r.agentPath, r]));
  const nextMap = new Map(next.map((r) => [r.agentPath, r]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, r] of nextMap) {
    const p = prevMap.get(k);
    if (!p) added.push(r);
    else if (canonical(p) !== canonical(r)) changed.push({ before: p, after: r });
  }
  for (const [k, r] of prevMap) if (!nextMap.has(k)) removed.push(r);
  return { added, removed, changed };
}

export function createBookkeepingCache({
  fetchRows,
  ttlMs = 15_000,
  hardStaleMs = 300_000,
  now = () => Date.now(),
  onRefresh = null,
}) {
  let snap = null; // { at, rows, bySlug }
  let inflight = null;

  const buildSnap = (rows) => ({
    at: now(),
    rows,
    bySlug: new Map(rows.map((r) => [slugFor(r.agentPath), r])),
  });

  const load = async () => {
    const rows = (await fetchRows()) ?? [];
    const next = buildSnap(rows);
    const diff = snap ? diffDeployments(snap.rows, next.rows) : { added: [], removed: [], changed: [] };
    snap = next;
    inflight = null;
    try {
      onRefresh?.(diff, next);
    } catch { /* a broken hook must never break the refresh */ }
    return next;
  };

  // Single-flight: concurrent stale readers share one refresh promise.
  const refresh = () => {
    if (!inflight) {
      inflight = load().catch((e) => {
        inflight = null;
        throw e;
      });
    }
    return inflight;
  };

  const stale = () => !snap || now() - snap.at >= ttlMs;

  return {
    // Rows for enumeration. Cold start waits for the first load (its failure
    // propagates — the route layer's 503); a warm-but-stale snapshot is
    // served immediately while a refresh runs in the background.
    async rows() {
      if (!snap) return (await refresh()).rows;
      if (stale()) void refresh().catch(() => {});
      return snap.rows;
    },

    // Slug resolution for the A2A turn path: O(1) against the snapshot,
    // never degrades for staleness (an already-known deployment keeps
    // serving; only enumeration faces hard-degrade — design D2.1).
    async resolve(slug) {
      if (!snap) await refresh();
      else if (stale()) void refresh().catch(() => {});
      return snap?.bySlug.get(slug) ?? null;
    },

    // Blocking best-effort refresh for the enumeration guard (fd-prod
    // finding #2, mirrored in fd-wanxing): once past the hard window the
    // guard would otherwise block the only path that ever triggers a
    // refresh — an idle facade deadlocks its own catalog.
    async poke() {
      if (!snap || now() - snap.at >= ttlMs) await refresh();
      return true;
    },
    stalenessMs() {
      return snap ? now() - snap.at : Infinity;
    },
    // Hard-stale only applies AFTER a snapshot existed: a never-loaded cache
    // must let requests through to the loader — gating on !snap deadlocks
    // cold start behind the enumeration guard (live fd-prod finding 10-04).
    hardStale() {
      return snap != null && now() - snap.at > hardStaleMs;
    },
    diffDeployments,
  };
}
