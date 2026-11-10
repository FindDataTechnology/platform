// ── Injection surface accounting (trim-mcp-injection-per-post 1.1) ──────────
//
// The cell composes ONE mcp.patch.yml for every persona, so the number of
// servers it carries is also the number whose tool schemas every turn pays
// for. Live 2026-11-09 the owner cell carried 34 servers while a single post
// referenced 2–3 of them; nobody had a number to look at, and the resulting
// context growth was diagnosed three times (platform churn → MCP count →
// actually cron session reuse) before the data settled.
//
// This module turns the surface into two facts that can be logged and compared
// over time. It deliberately reports only what it was given: no estimated
// token cost, because a fabricated number is worse than no number.

/**
 * @param {{ serverNames?: string[], skillRoots?: number }} input
 * @returns {{ servers: number, skillRoots: number }}
 */
export function summarizeInjectionSurface({ serverNames = [], skillRoots = 0 } = {}) {
  const names = Array.isArray(serverNames) ? serverNames.filter((n) => typeof n === "string" && n) : [];
  const roots = Number(skillRoots);
  return {
    servers: names.length,
    skillRoots: Number.isFinite(roots) && roots > 0 ? Math.floor(roots) : 0,
  };
}

/**
 * One-line summary for the composition log. Kept separate from the counting so
 * the message format can change without touching the numbers.
 */
export function describeInjectionSurface({ serverNames = [], skillRoots = 0 } = {}) {
  const { servers, skillRoots: roots } = summarizeInjectionSurface({ serverNames, skillRoots });
  return `${servers} MCP server(s), ${roots} skill root(s)`;
}
