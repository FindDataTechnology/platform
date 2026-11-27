// ── Notification action bridge (add-broadcast-and-notification-inbox 3.3) ────
//
// Acting on a notice runs it through the platform's EXISTING admission gate —
// the action registry + `proposeAction` — and not through any path of its own.
// That is the whole requirement: a notice must never become an authority the
// caller did not have.
//
// What this means concretely, and why the notice carries `{actionId, args}`
// rather than the `{tool, args}` the design first sketched: the platform has
// exactly ONE permission-checked way to invoke a tool (the action gate). An
// arbitrary MCP tool name is NOT reachable from here — no preflight, no
// mandate, no risk tier — so accepting a free-form tool name would either
// bypass all of that or fail for every notice. Naming a REGISTERED action is the
// honest contract, and an unregistered one is refused by name.
//
// The gate's own tiers do the rest for free:
//   read            → executes immediately (auto)
//   write/destructive/cost → returns `pending`: the agent PROPOSED it, the
//                     owner still has to approve. A notice can start work; it
//                     cannot confirm it.
//   publish         → awaiting async approval, unchanged.

import { proposeAction } from "../server/routes/actions.js";
import { isRegistered } from "./action-registry.js";

/**
 * Minimal req/res pair for `proposeAction`.
 *
 * `proposeAction` is written against a real Express request because that is
 * what every other caller is. Faking the fields it actually reads — `user`,
 * `body`, `ctx` in; `status(...).json(...)` out — keeps the admission logic in
 * ONE place instead of forking a parallel executor that would drift from it.
 */
function syntheticExchange({ actionId, args, ownerEmail, ctx }) {
  const req = {
    body: { actionId, args, proposerEmail: ownerEmail },
    // `internal: true` is what makes `resolveProposerEmail` read the named
    // proposer instead of a session — this call has no session. The loopback
    // child guard (server/auth.js INTERNAL_BRIDGES) already established that
    // this is the cell's own child, and the route pinned the owner to the cell.
    user: { email: "notify-bridge@internal", internal: true },
    ctx: ctx ?? null,
  };
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(body) {
      payload = body;
      return res;
    },
  };
  return { req, res, result: () => ({ status: statusCode, body: payload }) };
}

/**
 * Run a notice's action through the admission gate.
 *
 * Returns `{ ok, status, body }`. `ok` means the gate ACCEPTED the request —
 * not that the effect happened: read actions execute, everything above `read`
 * comes back `pending` for the owner to approve, which is a success of the
 * "propose" verb and must be reported as such.
 *
 * @param {object} deps
 * @param {{kind?: string, actionId?: string, tool?: string, args?: object}} deps.action
 * @param {string} deps.ownerEmail
 * @param {object} [deps.ctx]
 */
export async function runNotificationAction({ action, ownerEmail, ctx = null } = {}) {
  // `tool` is accepted as an alias so an action written before this decision is
  // still interpreted the one honest way (as a registered action id) rather than
  // silently doing nothing.
  const actionId = String(action?.actionId ?? action?.tool ?? "").trim();
  if (!actionId) {
    return { ok: false, status: 400, body: { error: "notification action must name an actionId" } };
  }
  if (!ownerEmail) {
    return { ok: false, status: 400, body: { error: "notification action requires an owner identity" } };
  }
  if (!isRegistered(actionId)) {
    return {
      ok: false,
      status: 400,
      body: { error: `notification action "${actionId}" is not a registered action`, code: "tool_not_registered" },
    };
  }
  const { req, res, result } = syntheticExchange({
    actionId,
    args: action?.args && typeof action.args === "object" ? action.args : {},
    ownerEmail,
    ctx,
  });
  await proposeAction(req, res);
  const out = result();
  return { ok: out.status < 400, status: out.status, body: out.body };
}
