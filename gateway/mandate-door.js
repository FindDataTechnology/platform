// ── Disclosure-gate machine door: the decision, without Express ─────────────
//
// fix-disclosure-gate-reachability D2/D3. The verdict channel is
// machine-to-machine, and the cell-proxy catch-all refuses anything without a
// user identity — measured 2026-11-11: a *correct* bearer got
// `401 Authentication required`, forever. The gateway therefore needs its own
// door, and that door needs three rules that are easy to get subtly wrong:
//
//   1. the bearer is checked FIRST; the owner header means nothing until it does;
//   2. the target must be a RUNNING cell named by that header;
//   3. there is NO default cell. A fallback would answer A's text with B's
//      policy — the single failure this endpoint exists to prevent.
//
// Kept as a pure function so the rules are contract-tested without booting a
// gateway, and so the wire in gateway/index.js stays a thin adapter (the
// project's repeated lesson: a green suite over the decision proves nothing
// about whether the seam calls it).
import { secretMatches } from "../server/auth.js";

export const MANDATE_VERDICT_PATH = "/api/actions/mandate-verdict";
export const MANDATE_OWNER_HEADER = "x-mandate-owner";

/**
 * @param {object} input
 * @param {string} input.configuredToken   deployment-injected bearer ("" = unconfigured)
 * @param {string} input.authorization     the raw Authorization header
 * @param {string} input.ownerHeader       the raw x-mandate-owner header
 * @param {Array}  input.runningCells      [{ user, state, port }] from the registry
 * @returns {{status:number, error?:string, owner?:string, cell?:object}}
 */
export function decideMandateDoor({ configuredToken, authorization, ownerHeader, runningCells } = {}) {
  const expected = String(configuredToken ?? "");
  // Unconfigured is a 503, never a pass — same posture as the cell-side handler.
  if (!expected) return { status: 503, error: "mandate verdict channel not configured" };

  const provided = String(authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!provided || !secretMatches(provided, expected)) return { status: 401, error: "unauthorized" };

  // Only now does the caller's claim about the target cell mean anything.
  const owner = String(ownerHeader ?? "").trim().toLowerCase();
  if (!owner) return { status: 400, error: `${MANDATE_OWNER_HEADER} is required` };

  const cell = (Array.isArray(runningCells) ? runningCells : []).find(
    (c) => String(c?.user ?? "").toLowerCase() === owner && c?.state === "running",
  );
  if (!cell) return { status: 404, error: "no running cell for that owner" };
  return { status: 200, owner, cell };
}
