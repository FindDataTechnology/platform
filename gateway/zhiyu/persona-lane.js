// ── Persona seats: a post running on THIS cell answers a room ───────────────
//
// The sibling lane (agent-lane.js) seats MARKET deployments: ref `${packId}:${agentId}`,
// resolved against the deployment ledger, answered through the registry's a2a
// endpoint, billed by host-settle.
//
// A persona/auditor post is none of those. It runs on the owner's own cell, has
// no deployment row, and is not for sale — so it answers through the cell's
// synchronous turn endpoint (server/routes/gateway-turn.js) and bills through
// the cell's own metering, which already counts every turn.
//
// Why this exists at all: a human builds a team locally, opens a room, and the
// team's posts cannot be addressed — "unpublished" silently reads as "unusable".
// Visibility governs OUTSIDE callers; it must not govern who may speak inside
// the owner's own room.

/**
 * @param {object} deps
 * @param {(onBehalfOf: string) => {base: string, email: string, secret: string}|null|Promise<...>} deps.cellFor
 *   The cell's loopback base + the identity to present. Returning null means the
 *   owner has no running cell — the seat is honestly unavailable.
 * @param {(timeoutMs: number) => number} [deps.turnTimeoutMs]
 */
export function createZhiyuPersonaLane({ cellFor, turnTimeoutMs = () => Number(process.env.ROOM_TURN_TIMEOUT_MS || 180000), fetchImpl = fetch }) {
  /** `persona:<fleetId>:<memberId>` → its parts, or null when the ref is another kind. */
  function parseRef(ref) {
    const parts = String(ref ?? "").split(":");
    if (parts.length !== 3 || parts[0] !== "persona") return null;
    const [, fleetId, memberId] = parts;
    if (!fleetId || !memberId) return null;
    return { fleetId, memberId };
  }

  /** Whether this lane owns the ref — the dispatcher asks this, not the shape. */
  const handles = (ref) => parseRef(ref) !== null;

  async function callAgent(member, { text, contextId = null } = {}) {
    const parsed = parseRef(member?.ref);
    if (!parsed) throw new Error(`not a persona seat: ${member?.ref}`);
    // `cellFor` may be async: the owner's cell is woken on demand, and waking
    // is an I/O step. Awaiting here keeps the lane callable either way.
    const cell = await cellFor?.(member?.onBehalfOf ?? null);
    if (!cell?.base) throw new Error(`no running cell for ${member?.onBehalfOf ?? "this owner"}`);
    const body = {
      fleetId: parsed.fleetId,
      memberId: parsed.memberId,
      text,
      contextId,
      timeoutMs: turnTimeoutMs(),
    };
    let r;
    try {
      r = await fetchImpl(`${String(cell.base).replace(/\/+$/, "")}/api/gateway/sync-turn`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The cell re-checks that the fleet belongs to this identity; the
          // header is the claim, not the proof.
          "x-forwarded-email": cell.email,
          ...(cell.secret ? { "x-cloud-gateway-secret": cell.secret } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(turnTimeoutMs() + 15_000),
      });
    } catch (err) {
      // A transport failure is the seat being unreachable, not the model
      // refusing — the room must be able to say which.
      const e = new Error(`persona seat unreachable: ${err?.message || err}`);
      e.code = "SEAT_UNREACHABLE";
      throw e;
    }
    let payload = null;
    try {
      payload = await r.json();
    } catch { /* non-JSON body — handled below */ }
    if (!r.ok || !payload) {
      const err = new Error(payload?.error || `sync-turn HTTP ${r.status}`);
      err.status = r.status;
      err.code = payload?.code ?? null;
      throw err;
    }
    if (payload.ok !== true) {
      const err = new Error(payload.error || "the post could not answer");
      err.code = payload.code ?? "TURN_FAILED";
      throw err;
    }
    // Same return shape as the agent lane, so the room's turn loop is lane-agnostic.
    return { text: String(payload.text ?? "") };
  }

  /**
   * Settlement. A persona seat bills through the cell's own turn metering — the
   * turn that just ran was recorded there, so there is nothing for the gateway
   * to settle and nothing to double-charge. Returning `{ settled: false,
   * reason }` is the honest answer: it says the gateway did not bill it, rather
   * than inventing a zero.
   */
  async function settleTurn() {
    return { settled: false, reason: "cell-metered" };
  }

  return { handles, parseRef, callAgent, settleTurn };
}
