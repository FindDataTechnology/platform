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
 *  - `allowed` undefined/null ⇒ return the input unchanged. This is the
 *    safety valve: a post that declares no MCP face (legacy pack, chat lane)
 *    must keep the pre-change composition byte-for-byte.
 *  - `allowed` EMPTY SET ⇒ narrow to the platform obligations only (fleet,
 *    fleet-architect, plus fd-memory when keepMemory). This is the meaning of
 *    an EXPLICITLY EMPTY declaration: "this role buys no integration", which
 *    is not the same statement as "this role declared nothing at all". The
 *    two used to collapse into one result, so 13 installed packs whose
 *    personas call `report_status` carried the full 13-server surface
 *    (measured 2026-11-27: 48.3% of turns ran at ≥12 servers).
 *    Pass `emptyMeansObligationsOnly: false` to keep the old
 *    empty-means-no-narrowing behaviour.
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
export function trimServersToFace(insert, { allowed = null, keepMemory = false, emptyMeansObligationsOnly = false } = {}) {
  if (!Array.isArray(insert) || insert.length === 0) return Array.isArray(insert) ? [...insert] : [];
  const set = allowed instanceof Set
    ? allowed
    : Array.isArray(allowed)
      ? new Set(allowed.filter((n) => typeof n === "string" && n))
      : null;
  if (!set) return [...insert];
  // 空集：只有调用方明确说「空 = 只要平台义务」时才收窄；否则沿用旧语义。
  if (set.size === 0 && !emptyMeansObligationsOnly) return [...insert];
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
    // 读面同样是平台义务，不是岗位买的能力（baseline-fleet-bridge-for-member-pods）。
    // 平台每轮都在 prompt 里注入岗位身份（`【集群岗位身份】fleet=… post=…`），
    // 却不保证这个岗位读得到自己的舰队：只留 `fleet` 等于「能报数、看不见」。
    // 2026-11-14 实测（用户本人 cell）：47 条主人待办里 4 票是这一类——盘账岗/
    // 提案岗/评测岗报 `fleet_list`/`fleet_turns_read`/`fleet_spec_read` 不可调用，
    // 而报数一切正常；37 个已装 pack 里声明 `fleet-architect` 的只有 4 个。
    // 这条豁免只**保留已在 insert 里的行**（从不新增）⇒ 公开面收窄与显式停用
    // 仍然优先：被上层裁掉的行，这里救不回来。
    if (name === "fleet-architect") return true;
    if (name === "fleet") return true;
    return false;
  });
}

/**
 * The server names a set of tool faces reference, as a Set.
 *
 * Accepts the `mcpTools` shape the filter doc uses: `{ [serverName]: string[] }`.
 * An empty map yields an empty Set. What that MEANS is the caller's decision:
 * `trimServersToFace` narrows to the platform obligations only when the caller
 * passes `emptyMeansObligationsOnly`, and otherwise keeps the full
 * composition (the pre-2026-11-27 behaviour for a post that declares nothing).
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

/**
 * 同一服务的多个别名合并（injection-surface-accounting 3.x）。
 *
 * 生产实测 2026-11-27：某个 member patch 同时带 `facet-market` 与
 * `facet-market-mcp` 指向同一端点，32 个 server 里有重复。每个 server 的
 * 工具 schema 都要进静态前缀，重复条目就是纯浪费。
 *
 * 判定同一服务：`transport + url（去掉尾部斜杠）+ Authorization`。
 * 为什么不只按 url：同一端点的两个租户凭据是两个不同的服务，合了会让
 * 其中一方拿到别人的数据。为什么不按名字：名字是别名，正是要合并的东西。
 *
 * @param {Array<{id?: string, config?: {serverName?: string, transport?: string, url?: string, headers?: Record<string,string>}}>} insert
 * @returns {{ entries: Array, merged: Array<{kept: string, dropped: string}> }}
 */
export function dedupeServerEntries(insert) {
  if (!Array.isArray(insert)) return { entries: [], merged: [] };
  const seen = new Map();
  const entries = [];
  const merged = [];
  for (const entry of insert) {
    const cfg = entry?.config ?? {};
    const url = typeof cfg.url === "string" ? cfg.url.replace(/\/+$/, "") : "";
    const auth = cfg?.headers?.Authorization ?? cfg?.headers?.authorization ?? "";
    const key = url ? `${cfg.transport ?? ""}|${url}|${auth}` : `name|${cfg.serverName ?? entry?.id ?? ""}`;
    const prev = seen.get(key);
    if (prev) {
      merged.push({ kept: prev?.config?.serverName ?? prev?.id ?? "?", dropped: cfg.serverName ?? entry?.id ?? "?" });
      continue;
    }
    seen.set(key, entry);
    entries.push(entry);
  }
  return { entries, merged };
}
