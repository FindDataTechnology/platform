// Health snapshot — pure, zero imports, so it can be tested without a DB or an app.
//
// WHY THIS EXISTS (retire-orphan-platform-state 4.3): the health surface used to
// hardcode `status: "healthy"`. The route only left that state when the whole
// handler threw, which meant: if the cluster store returned nothing readable —
// wrong DB file, empty store, a reader that degraded to a snapshot — the endpoint
// still answered `healthy` with `clusters: {total: 0, active: 0}`. A zero that
// came from "could not read" is indistinguishable from a zero that means "no
// clusters configured", so the red/green of every monitor on top of it was
// untrustworthy.
//
// The rule this encodes (the platform diagnostics discipline: judge liveness
// first, conclude second): a diagnostic that cannot read its live source must
// say `degraded` and name the source, and must never substitute a
// plausible-looking number.
//
// What counts as DEGRADED: the reader throws, returns nothing, or returns
// something that is not two finite counts. What does NOT: a genuine `0` — an
// empty platform is healthy, and conflating the two is the defect this file fixes.

/**
 * @param {object} opts
 * @param {() => {total: number, active: number}} opts.readClusters  live reader
 * @param {number} [opts.now]
 * @param {number} [opts.uptime]
 * @param {{used: string, total: string}} [opts.memory]
 * @returns {{status: "healthy"|"degraded", timestamp: number, uptime: number,
 *            memory?: object, clusters: {total: number, active: number}|null,
 *            degraded?: string[]}}
 */
export function healthSnapshot({ readClusters, now = Date.now(), uptime = 0, memory = null } = {}) {
  const degraded = [];
  let clusters = null;

  try {
    if (typeof readClusters !== "function") throw new Error("no cluster-store reader wired");
    const c = readClusters();
    if (!c || typeof c !== "object") throw new Error("cluster-store returned nothing");
    // `0` is a legitimate answer (no clusters). A non-number is not an answer.
    if (!Number.isFinite(c.total) || !Number.isFinite(c.active)) {
      throw new Error(`cluster-store returned non-numeric counts (total=${fmt(c.total)}, active=${fmt(c.active)})`);
    }
    clusters = { total: c.total, active: c.active };
  } catch (err) {
    degraded.push(`cluster-store: ${err && err.message ? err.message : String(err)}`);
  }

  const body = {
    status: degraded.length ? "degraded" : "healthy",
    timestamp: now,
    uptime,
    // null, never 0: "could not read" must not be reportable as "there are none".
    clusters,
  };
  if (memory) body.memory = memory;
  if (degraded.length) body.degraded = degraded;
  return body;
}

function fmt(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
