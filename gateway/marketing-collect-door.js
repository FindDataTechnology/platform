// ── Marketing collect door (close-marketing-funnel) ─────────────────────────
//
// Pure decision, separated from gateway/index.js so it is testable without
// assembling the whole app. The failure this function exists to prevent is
// measured, not hypothetical: the first version read `cell.email` off
// `registry.status()`, whose projection calls the field `user` — so it passed
// `undefined` into forwardedHeaders and every request 500'd with
// ERR_HTTP_INVALID_HEADER_VALUE (2026-11-19, in production).
//
// Rules:
//   * an unset MARKETING_EVENTS_CELL means "the first running cell", not "no
//     target" — the collector is not per-user, it is one machine-owned inbox;
//   * a named cell that is not running is a REFUSAL, never a fallback to some
//     other cell (a fallback would write one user's counters into another's db);
//   * a target without a `user` is a refusal too — the header would be
//     undefined, and a 503 that says why beats a 500 that says nothing.

export const MARKETING_COLLECT_PATH = "/api/marketing/collect";

/**
 * @param {{owner?: string, cells: Array<{user?: string, port?: number}>}} input
 * @returns {{ok: true, cell: {user: string, port: number}} | {ok: false, status: number, reason: string}}
 */
export function decideMarketingCollectDoor({ owner, cells }) {
  const named = String(owner || "").trim();
  const running = (Array.isArray(cells) ? cells : []).filter((c) => c && c.user && c.port);

  if (named) {
    const match = running.find((c) => c.user === named);
    if (!match) {
      return {
        ok: false,
        status: 503,
        reason: `no running cell for MARKETING_EVENTS_CELL=${named}`,
      };
    }
    return { ok: true, cell: { user: match.user, port: match.port } };
  }

  if (running.length === 0) {
    return { ok: false, status: 503, reason: "no running cell available for marketing collection" };
  }
  return { ok: true, cell: { user: running[0].user, port: running[0].port } };
}
