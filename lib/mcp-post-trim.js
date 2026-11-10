// ── Per-post server trimming (trim-mcp-injection-per-post 2.x) ──────────────
//
// The cell composes ONE mcp.patch.yml for every persona, so all 34 servers'
// tool schemas are in scope for every turn regardless of which post is
// running. Live 2026-11-09/10 the owner cell carried 34 servers while a single
// post referenced 3; after cron-session rotation shipped, a freshly rotated
// round STILL died with "turn stopped early — context pressure (4
// compactions)" because a new session starts out already near the window.
//
// Rotation and trimming are complementary: rotation cures "worse the longer it
// runs", trimming cures "starts out too high". This module is the trimming
// half, as pure functions so the policy is testable without a cell.

/**
 * Narrow a server-entry list to the servers a post actually references.
 *
 * Semantics:
 *  - `allowed` undefined/null/empty ⇒ return the input unchanged. This is the
 *    safety valve: a post that declares no MCP face (legacy pack, chat lane)
 *    must keep the pre-change composition byte-for-byte.
 *  - An entry whose `serverName` is in `allowed` is kept.
 *  - Entries whose serverName is NOT in `allowed` are dropped.
 *  - A `memory` row is kept when `keepMemory` is true even if it is not in the
 *    face: the member token path appends it deliberately and trimming it would
 *    silently disable a post's memory.
 *
 * @param {Array<{config?: {serverName?: string}}>} insert
 * @param {{ allowed?: string[]|Set<string>|null, keepMemory?: boolean }} [opts]
 * @returns {Array} a NEW array (never mutates the input)
 */
export function trimServersToFace(insert, { allowed = null, keepMemory = false } = {}) {
  if (!Array.isArray(insert) || insert.length === 0) return Array.isArray(insert) ? [...insert] : [];
  const set = allowed instanceof Set
    ? allowed
    : Array.isArray(allowed)
      ? new Set(allowed.filter((n) => typeof n === "string" && n))
      : null;
  if (!set || set.size === 0) return [...insert];
  return insert.filter((entry) => {
    const name = entry?.config?.serverName;
    if (typeof name !== "string" || !name) return false;
    if (set.has(name)) return true;
    if (keepMemory && name === "fd-memory") return true;
    // PLATFORM OBLIGATION, never a declared capability: the `fleet` server
    // carries `report_status` (and escalate). A post's contract is "收尾必
    // report_status", and no pack ever declares `fleet` in its allowTools
    // because it is not a capability the pack buys — it is the lane every post
    // reports through. Trimming it away was a real regression, caught live
    // 2026-11-10: the inventory post ran fine (out=871, a full five-column
    // ledger in its text) but the ledger got no report, and the trace shows it
    // calling `tool_search {query:"report_status"}` TWICE — hunting a tool that
    // no longer existed. Silent, and exactly backwards: the round did the work
    // and could not file it.
    if (name === "fleet") return true;
    return false;
  });
}

/**
 * The server names a set of tool faces reference, as a Set.
 *
 * Accepts the `mcpTools` shape the filter doc uses: `{ [serverName]: string[] }`.
 * An empty map yields an empty Set, which `trimServersToFace` treats as "no
 * narrowing" — callers must decide whether that is the intended meaning for
 * their case (it is for a post that declares nothing).
 *
 * @param {Record<string, string[]>|null|undefined} mcpTools
 * @returns {Set<string>}
 */
export function serversFromFace(mcpTools) {
  if (!mcpTools || typeof mcpTools !== "object" || Array.isArray(mcpTools)) return new Set();
  return new Set(Object.keys(mcpTools).filter((k) => typeof k === "string" && k));
}

/**
 * One-line report for the composition log: how much was trimmed and which
 * servers survived. Reported, never silently applied.
 */
export function describeTrim(before, after) {
  const b = Array.isArray(before) ? before.length : 0;
  const a = Array.isArray(after) ? after.length : 0;
  return `trimmed ${b} → ${a} server(s)${a < b ? ` (dropped ${b - a})` : ""}`;
}
