// Market-agent discovery: the search view and the text a fleet/human caller
// reads (fix-agent-discovery-honesty).
//
// Why this module exists: the same defect lived on two faces. The route sliced
// matches at 8 with no total; the delegation MCP child printed that slice's
// length as "Online market agents (8)". A keyword matching 30 answered "8", and
// the delegating model picked from an arbitrary slice believing it had
// enumerated the market. Both faces now come from ONE definition here — and it
// is import-safe (the MCP module spawns a server at import, so a unit test
// cannot reach the formatter through it).

// The default keeps a search answer inside a sane prompt budget; the ceiling
// bounds what a caller may ask for. Both are stated in the response's
// `total`/`truncated` so a capped page is never mistaken for the whole market.
export const AGENT_SEARCH_LIMIT = 8;
export const AGENT_SEARCH_MAX = 50;

export function searchAgentsView({ all = [], search = "", limit = null } = {}) {
  const q = String(search ?? "").trim().toLowerCase();
  const matches = all
    .filter((a) => {
      if (!q) return true;
      const hay = `${a.id} ${a.name} ${a.description} ${a.category} ${a.tags.join(" ")}`.toLowerCase();
      return hay.includes(q);
    })
    // Deterministic order: the catalog's scan order is an implementation
    // detail, and a cap applied to an unstable order hands back a DIFFERENT
    // page on every call — "which agents you can see" must not be arbitrary.
    .sort((x, y) => String(x.name).localeCompare(String(y.name)) || String(x.id).localeCompare(String(y.id)));
  const requested = Number.parseInt(String(limit ?? ""), 10);
  const cap = Number.isFinite(requested) && requested > 0 ? Math.min(requested, AGENT_SEARCH_MAX) : AGENT_SEARCH_LIMIT;
  const agents = matches.slice(0, cap);
  return { agents, total: matches.length, truncated: matches.length > agents.length };
}

export function formatSearchAgentsText({ agents = [], total = null, truncated = false } = {}) {
  if (!agents.length) {
    return "No online market agents match — try another keyword, or drop the agent target.";
  }
  const lines = agents.map((a) => `- ${a.id} — ${a.name} (${a.category || "uncategorized"}): ${(a.description || "").slice(0, 120)}`);
  const heading = truncated
    ? `Online market agents — showing ${agents.length} of ${total} matches`
    : `Online market agents (${total ?? agents.length})`;
  const hint = truncated
    ? "\nNarrow the keyword to see the rest, or pass limit (up to 50) to page this search."
    : "";
  return `${heading}:\n${lines.join("\n")}${hint}\nPass an id as delegate_task's agent parameter.`;
}
