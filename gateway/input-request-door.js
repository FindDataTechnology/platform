// ── Input-request machine door: the ACP lane reaches the same tool ──────────
//
// add-acp-input-request-owner (follow-up to add-input-request-cards D2). An ACP
// harness has no stdio MCP mount and no userQuestions seam, so the platform
// exposes request_input as a streamable-HTTP MCP endpoint and the runner calls
// it with a deployment-injected shared bearer. That call hits exactly the wall
// the disclosure gate hit: the cell-proxy catch-all refuses anything without a
// user identity, so a *correct* bearer answered `401 Authentication required`
// before the cell ever saw it (measured 2026-11-12 on sha-f34ed77 — the mount is
// real, the gateway just never let the request through).
//
// Same three rules as gateway/mandate-door.js, because they are the same three
// ways a machine door goes wrong:
//   1. the bearer is checked FIRST; the owner header means nothing until it does
//      (otherwise an unauthenticated caller could name a cell);
//   2. the target must be a RUNNING cell named by that header;
//   3. there is NO default cell — answering with anybody else's cell would put
//      one owner's card in another owner's context, the exact leak this lane
//      must never have.
//
// Kept pure so the rules are contract-tested without booting a gateway, and so
// the wire in gateway/index.js stays a thin adapter (the project's repeated
// lesson: a green suite over the decision proves nothing about whether the seam
// calls it — that half is pinned in scripts/test-gateway-assembly.mjs).
import { secretMatches } from "../server/auth.js";

// The cell's mount uses the same string (server/input-request-http.js). Pinned
// equal by scripts/test-input-request-door.mjs so the two cannot drift apart.
export const INPUT_REQUEST_MCP_PATH = "/api/mcp/input-request/mcp";
export const INPUT_REQUEST_OWNER_HEADER = "x-input-request-owner";

/**
 * @param {object} input
 * @param {string} input.configuredToken  deployment-injected bearer ("" = unconfigured)
 * @param {string} input.authorization    the raw Authorization header
 * @param {string} input.ownerHeader      the raw x-input-request-owner header
 * @param {Array}  input.runningCells     [{ user, state, port }] from the registry
 * @returns {{status:number, error?:string, owner?:string, cell?:object}}
 */
export function decideInputRequestDoor({ configuredToken, authorization, ownerHeader, runningCells } = {}) {
  const expected = String(configuredToken ?? "");
  // Unconfigured is a 404, never a pass — the cell-side handler answers
  // `not_configured` the same way, so the two sides never disagree about
  // whether this lane exists at all.
  if (!expected) return { status: 404, error: "not_configured" };

  const provided = String(authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!provided || !secretMatches(provided, expected)) return { status: 401, error: "unauthorized" };

  // Only now does the caller's claim about the target cell mean anything.
  const owner = String(ownerHeader ?? "").trim().toLowerCase();
  if (!owner) return { status: 400, error: `${INPUT_REQUEST_OWNER_HEADER} is required` };

  const cell = (Array.isArray(runningCells) ? runningCells : []).find(
    (c) => String(c?.user ?? "").toLowerCase() === owner && c?.state === "running",
  );
  if (!cell) return { status: 404, error: "no running cell for that owner" };
  return { status: 200, owner, cell };
}
