// ── Runner-fleet machine door ────────────────────────────────────────────────
//
// add-fleet-bridge-endpoint-for-agent-runner 4.3. The bridge was built as if the
// runner could reach its cell directly; measured 2026-11-14 it cannot. The
// listener on :3100 is the GATEWAY (`gateway/index.js`), and the cells sit
// behind it on 127.0.0.1:<random>. The cell-side `runnerFleetGate` therefore
// never sees a bridge request: the catch-all's `resolveUser` finds no interactive
// identity and answers `401 Authentication required` — byte-identical to the
// cell gate's own refusal, which is why this looked like "the token is wrong"
// for two hours while the token matched by sha256.
//
// Same three rules as gateway/input-request-door.js and gateway/mandate-door.js,
// because they are the same three ways a machine door goes wrong:
//   1. the bearer is checked FIRST; the owner header means nothing until it does
//      (otherwise an unauthenticated caller could name a cell);
//   2. the target must be a cell that actually exists for that owner — the cell
//      resolves the fleet owner from its OWN `ctx.cellUserEmail`, so naming the
//      wrong cell silently answers with somebody else's fleets;
//   3. there is NO default cell. A fallback would report one owner's fleet
//      status into another owner's ledger — the exact mis-attribution the
//      satellite-sharing and deputy-attribution suites exist to prevent.
//
// Why the owner header is required and not optional: `fleet_list`'s inputSchema
// is an empty object (no `turn_token`), so the read face has no per-call
// coordinate to resolve against. The only place the coordinate can come from is
// the caller, and the caller (the runner's bridge child) gets it from the
// per-agent MCP row header — a value the model cannot forge, because the
// satellite host strips the reserved argument before writing it back.
//
// Kept pure so the rules are contract-tested without booting a gateway; the wire
// in gateway/index.js stays a thin adapter, and scripts/test-gateway-assembly.mjs
// pins that the wire is actually there (the repo's standing lesson: a green suite
// over a decision proves nothing about whether the seam calls it).
import { secretMatches } from "../server/auth.js";

/** Both mounts of the bridge live under this prefix on the public plane. The
 *  cell mounts `/api/runner-fleet/fleets` and `/api/runner-fleet/architect`
 *  (server.js), and the runner's own child appends `/fleets/...`. Pinned equal
 *  to `FLEET_MCP_BRIDGE_PREFIX` by scripts/test-runner-fleet-door.mjs. */
export const RUNNER_FLEET_PATH_PREFIX = "/api/runner-fleet";
export const RUNNER_FLEET_PATH_RE = /^\/api\/runner-fleet(\/|$)/;

/** Owner coordinate for a bridge call. The runner row carries it as
 *  `x-fleet-bridge-owner` to its own satellite host; the child forwards it here
 *  under this name. One string, two hops, pinned by the same suite. */
export const FLEET_OWNER_HEADER = "x-fleet-owner";

/**
 * @param {object} input
 * @param {string} input.configuredToken  FLEET_RUNNER_BRIDGE_TOKEN ("" = unconfigured)
 * @param {string} input.authorization    the raw Authorization header
 * @param {string} input.ownerHeader      the raw x-fleet-owner header
 * @param {Array}  input.runningCells     [{ user, state, port }] from registry.status()
 * @returns {{status:number, error?:string, owner?:string, cell?:object|null}}
 */
export function decideRunnerFleetDoor({ configuredToken, authorization, ownerHeader, runningCells } = {}) {
  const expected = String(configuredToken ?? "").trim();
  // Unconfigured is 503, never a pass: the cell's own gate answers
  // `runner fleet bridge not configured` the same way, so the two mounts never
  // disagree about whether this lane exists at all.
  if (!expected) return { status: 503, error: "runner fleet bridge not configured" };

  const provided = String(authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided || !secretMatches(provided, expected)) return { status: 401, error: "Authentication required" };

  // Only now does the caller's claim about the target owner mean anything.
  const owner = String(ownerHeader ?? "").trim().toLowerCase();
  if (!owner) return { status: 400, error: `${FLEET_OWNER_HEADER} is required` };

  // A cold cell is not a refusal: the wire may start it (`registry.ensure`),
  // exactly like the webhook and bot-relay paths. `cell: null` is that signal —
  // the door never invents a target on its own.
  const cell = (Array.isArray(runningCells) ? runningCells : []).find(
    (c) => String(c?.user ?? "").toLowerCase() === owner && c?.state === "running",
  );
  return { status: 200, owner, cell: cell ?? null };
}
