// Team a2a dispatch — the function `ctx.teamDispatch` was waiting for
// (openspec: add-team-as-a2a-agent, 3.4; unblocks 1.1/1.2 on this seam).
//
// WHY THIS FILE EXISTS AT ALL
// --------------------------
// `server/routes/team-cards.js` puts the whole call door inside
// `if (typeof ctx.teamDispatch === "function")`, and nothing ever assigned it.
// So on a real cell `/api/teams/:handle/a2a` was never registered: the team
// directory worked, the cards listed, and every call came back `not_serving`
// from the gateway (task 6.3's honest state). The door being absent was
// correct while there was no dispatcher; keeping it absent forever is not.
//
// WHAT IT REUSES (nothing here is a new orchestrator — task 3.4's own rule)
// -----------------------------------------------------------------------
//   • `runA2aTurn` (server/a2a-client.js) is the one a2a turn executor the
//     platform already has: SSE frames, the `X-Delegation-Depth` header and its
//     runner-side bound, the two-credential egress model.
//   • `recordTurnEvent` (server/fleet-events.js) is the one place a turn row is
//     shaped and attributed. The row lands on the reception post with
//     `source=delegation` and the chain depth — the same `member_turn_events`
//     the cockpit, the cost read-face and the run ledger already read. No new
//     table, no second bookkeeping.
//
// WHY A RECEPTION POST MUST BE `a2a`
// ----------------------------------
// A published team card's serving faces ARE a2a posts (`server/team-card.js`
// filters `targetKind === "a2a"`), and a cross-user call leaves the cell — it
// is a remote turn by nature. A reception on a local persona would have to
// drive the shared dsh child, and that lane (queueing, carrier, model plan)
// lives inside the cron executor. Rather than half-implement it and pretend,
// a non-a2a reception is refused BY NAME (`reception_not_remote`) before the
// remote turn starts: the caller gets a failure, not an empty success.
//
// DEPTH
// -----
// Outbound depth is inbound + 1 (task 1.2). The inbound value arrives from the
// `x-delegation-depth` header; `runA2aTurn` refuses at the bound, and this
// module refuses one step earlier so the refusal happens before a request is
// built (the caller sees `depth_bound`, not a generic transport error).

import * as catalog from "../catalog.js";
import { DELEGATION_DEPTH_BOUND, resolveGatewayCredential, runA2aTurn, outboundDelegationDepth } from "./a2a-client.js";
import { recordTurnEvent } from "./fleet-events.js";
import { getFleetDatabase } from "./routes/fleets-db.js";

/** A refusal the caller can act on, distinguished from a transport failure. */
function namedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Read a dependency that may be either a value or a live getter.
 *
 * `cellUserEmail` and `CLOUD_MODE` are attached to `ctx` OUTSIDE
 * `createAppContext` (the cell runtime sets the owner after the context
 * exists), so a value captured at construction would be null forever and every
 * hosted cell would silently fall back to the deployment credential — the
 * per-user attribution a2a traffic is supposed to carry (ADR-0013 C-lite).
 */
const live = (v) => (typeof v === "function" ? v() : v);

/**
 * Build the dispatcher. Every dependency is injectable so the suite can run
 * with no network, no credential and no shared DB:
 *
 *   getEntry(id)  → catalog entry ({ url, mode }) for an a2a target
 *   runTurn(...)  → the turn executor (runA2aTurn by default)
 *   fleetDb       → the fleet facade/DB a turn row is appended to
 */
export function createTeamDispatch({
  ownerEmail = null,
  cloudMode = false,
  getEntry = (id) => catalog.getAgentEntry(id),
  runTurn = runA2aTurn,
  fleetDb = null,
  log = console,
} = {}) {
  // Resolved lazily: a cell that never serves a team call must not open the
  // fleet DB just because the route was mounted.
  const dbFor = () => fleetDb ?? getFleetDatabase();

  return async function teamDispatch({ fleet, members = [], reception, text, caller, callId, depth = 0, onDelta } = {}) {
    const post = reception && members.some((m) => m.id === reception.id) ? reception : null;
    if (!post) {
      throw namedError("no_reception", "this team publishes a reception post that does not exist any more");
    }
    if (post.targetKind !== "a2a") {
      throw namedError(
        "reception_not_remote",
        `reception post 「${post.title ?? post.id}」 is a ${post.targetKind} post — only a2a receptions can answer a team call`,
      );
    }
    const entry = getEntry(post.targetId);
    if (!entry || entry.mode !== "a2a" || !entry.url) {
      throw namedError("reception_unreachable", `a2a target '${post.targetId}' is not in the catalog (or has no url)`);
    }

    // Same rule as every other outbound lane, from one place: a team call
    // continues the chain it arrived on.
    const outboundDepth = outboundDelegationDepth(depth, { topLevel: 1 });
    if (outboundDepth >= DELEGATION_DEPTH_BOUND) {
      // Named before the request exists: "the chain is too long" is a fact the
      // caller can fix (call the team directly), unlike a mid-stream abort.
      throw namedError(
        "depth_bound",
        `delegation depth ${outboundDepth} reaches the bound (${DELEGATION_DEPTH_BOUND}) — this call would amplify the chain`,
      );
    }

    const { gatewayToken } = resolveGatewayCredential({
      ownerEmail: live(ownerEmail) || null,
      cloudMode: !!live(cloudMode),
    });
    const agentToken = process.env.AGENT_SERVING_BACKEND_TOKEN || "";

    // The turn request this row is recorded from. `origin.fleet` pins the
    // reception post (resolveTurnPost prefers it over preset matching, which
    // would be ambiguous when two posts share one agent); `initiator` makes the
    // source `delegation` with `resultSink: caller` — both already-existing
    // vocabulary, not new enum values.
    const job = {
      id: callId ?? null,
      prompt: text ?? "",
      targetType: "a2a",
      preset: post.targetId,
      agent: post.targetId,
      sessionId: null,
      origin: { fleet: { fleetId: fleet?.id ?? null, memberId: post.id, depth: outboundDepth } },
      initiator: { handle: null, caller: caller?.subject ?? null },
    };

    const startedAt = Date.now();
    let outcome = null;
    try {
      const out = await runTurn(entry.url, job.prompt, {
        contextId: callId ?? undefined,
        depth: outboundDepth,
        gatewayToken,
        agentToken,
        ...(typeof onDelta === "function" ? { onDelta } : {}),
      });
      outcome = { ok: true, text: out?.text ?? "" };
      return { text: out?.text ?? "" };
    } catch (err) {
      outcome = {
        ok: false,
        error: err?.message || String(err),
        ...(err?.code ? { detail: { errorCode: String(err.code) } } : {}),
      };
      throw err;
    } finally {
      // Recorded on BOTH paths, and never allowed to turn a delivered answer
      // into a failure: a bookkeeping error is a warn (the row is a projection,
      // the caller already has their text).
      try {
        recordTurnEvent(dbFor(), job, outcome, { startedAt, endedAt: Date.now() });
      } catch (err) {
        log.warn?.(`[team-dispatch] could not record turn for ${callId}: ${err?.message || err}`);
      }
    }
  };
}
