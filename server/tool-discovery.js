// tool-discovery.js — parse, normalize, and rank the dsh tool roster so the
// agent can resolve an intent or a malformed name to the exact callable name.
//
// Two consumers share one matcher:
//   * the `tool_search` dsh tool (plugin side) reads the LIVE registry
//     projection at call time — that is the authoritative roster for the
//     calling agent's scope;
//   * the host's dsh-event translation keeps an ephemeral per-turn roster
//     projected from `request/header` tool schemas and enriches UNKNOWN_TOOL
//     results with exact-name candidates.
//
// Pure module: every function takes data in and returns data out. No I/O, no
// state, no mutation of inputs (tests assert that directly).

// A dsh model-facing tool schema is `{ name, description, parameters }` where
// `parameters` is a JSON-schema object. MCP tools arrive with the public name
// `mcp__<serverName>__<toolName>` (dsh-mcp-client contract; see dsh-profile.js
// comments) — names longer than dsh's 64-char budget are truncated + hashed,
// so the display name may not split cleanly and is kept whole.

const MCP_RE = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/s;

// Parse one model-facing tool schema into a discovery record. Non-MCP names
// (built-ins like read/grep, the library server's `mcp__library__*`, etc.)
// become `origin: "local"` records with no server/leaf split; MCP names
// (two `__` segments) become `origin: "mcp"` with `server` + `leaf`.
export function parseToolSchema(schema) {
  if (!schema || typeof schema !== "object" || typeof schema.name !== "string" || !schema.name) {
    return null;
  }
  const m = MCP_RE.exec(schema.name);
  const base = m
    ? { origin: "mcp", server: m[1], leaf: m[2] }
    : { origin: "local", server: null, leaf: schema.name };
  const params = schema.parameters && typeof schema.parameters === "object" ? schema.parameters : {};
  const properties = params.properties && typeof params.properties === "object" ? params.properties : {};
  const required = Array.isArray(params.required)
    ? params.required.filter((r) => typeof r === "string")
    : [];
  return {
    name: schema.name,
    ...base,
    description: typeof schema.description === "string" ? schema.description : "",
    required,
    properties,
  };
}

// Parse an array of model-facing schemas, dropping malformed entries.
export function parseToolSchemas(schemas) {
  return Array.isArray(schemas) ? schemas.map(parseToolSchema).filter(Boolean) : [];
}

// Normalize any query or name fragment into comparable tokens: lowercase,
// separators (including the `__` join and the user-visible mistakes `-`, `_`,
// spaces, `*`) become spaces, a standalone `mcp` token is dropped (it carries
// no discriminative power — every MCP name starts with it), and empty tokens
// are removed. `mcp__list_concepts`, `list concepts`, and `LIST-CONCEPTS`
// therefore all normalize to ["list", "concepts"].
export function normalizeTokens(input) {
  if (typeof input !== "string") return [];
  return input
    .toLowerCase()
    .replace(/[*?[\]{}]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && t !== "mcp");
}

function tokensOf(record) {
  return {
    full: normalizeTokens(record.name),
    server: normalizeTokens(record.server || ""),
    leaf: normalizeTokens(record.leaf || ""),
    description: normalizeTokens(record.description).slice(0, 40),
    params: normalizeTokens(Object.keys(record.properties || {}).join(" ")),
  };
}

// One authoritative ordering comparator: descending score, then full name —
// so the same query against the same roster always returns the same order.
function byScoreThenName(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.record.name < b.record.name ? -1 : a.record.name > b.record.name ? 1 : 0;
}

// Score one record against the query tokens. Deterministic lexical weights —
// exact name > leaf > server+leaf > name-token coverage > server > description
// > parameter names. `serverFilter` (already tokenized) boosts same-server
// records and zeroes out others' server component but does not exclude them
// (a wrong-filter query should still see the right answer, ranked honestly).
function scoreRecord(record, index, queryTokens, serverTokens) {
  const t = tokensOf(record);
  let score = 0;

  const normalizedQuery = queryTokens.join(" ");
  const fullExact = normalizedQuery && t.full.join(" ") === normalizedQuery;
  const leafExact = normalizedQuery && t.leaf.join(" ") === normalizedQuery;
  if (fullExact) score += 100;
  if (leafExact) score += 80;

  // Token coverage over the full name: every query token found somewhere in
  // name/server/leaf tokens. Weighted by coverage fraction so "wb search
  // indicators" beats a one-token graze.
  const nameTokens = new Set([...t.full, ...t.server, ...t.leaf]);
  let covered = 0;
  for (const token of queryTokens) if (nameTokens.has(token)) covered += 1;
  if (queryTokens.length) score += (covered / queryTokens.length) * 40;
  if (covered === queryTokens.length && queryTokens.length > 0) score += 10;

  if (serverTokens.length) {
    const serverHit = serverTokens.every((token) => t.server.includes(token));
    if (serverHit) score += 30;
    else {
      // A name-only graze on a foreign server must not beat a real match on
      // the requested server: the server gap costs 25 and coverage caps at
      // 50, so claw back the exact-name bonuses for foreign exact hits.
      score -= 25;
      if (fullExact) score -= 55;
      if (leafExact) score -= 55;
    }
  }

  let descriptionHits = 0;
  for (const token of queryTokens) if (t.description.includes(token)) descriptionHits += 1;
  if (queryTokens.length) score += (descriptionHits / queryTokens.length) * 12;

  let paramHits = 0;
  for (const token of queryTokens) if (t.params.includes(token)) paramHits += 1;
  score += paramHits * 3;

  // Index order is the final stable tiebreaker input (name comparator above
  // already handles distinct names; identical names cannot occur in a registry).
  return { record, score: score - index * 1e-6 };
}

// Search parsed records with a free-text or name-fragment query.
//   query        — intent text or (possibly malformed) tool-name fragment
//   server       — optional MCP server name to prefer/filter by
//   limit        — maximum results (bounded by the caller too)
// Records never contain credentials or execution metadata by construction:
// parseToolSchema projects only the model-facing fields.
export function searchToolRecords(records, { query, server, limit = 20 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  if (!Array.isArray(records) || records.length === 0) return [];
  const queryTokens = normalizeTokens(query);
  const serverTokens = normalizeTokens(server);
  if (!queryTokens.length && !serverTokens.length) return [];
  const scored = records.map((record, index) =>
    scoreRecord(record, index, queryTokens, serverTokens),
  );
  return scored
    .filter((entry) => {
      const t = tokensOf(entry.record);
      const onServer =
        !serverTokens.length || serverTokens.every((token) => t.server.includes(token));
      if (!queryTokens.length) return onServer; // server-only listing
      const exactFull = t.full.join(" ") === queryTokens.join(" ");
      if (!onServer) {
        // Server-filtered queries may still surface a name-exact hit from
        // another server, ranked honestly below the server's own matches.
        return exactFull;
      }
      if (entry.score <= 0) return false;
      const nameTokens = new Set([...t.full, ...t.server, ...t.leaf]);
      let covered = 0;
      for (const token of queryTokens) if (nameTokens.has(token)) covered += 1;
      // Require at least half of the query tokens to appear in the NAME
      // space, or an exact leaf/full match — except that an intent query
      // ("GDP indicator search") may also qualify through DESCRIPTION token
      // coverage when at least half the query tokens appear there. That is
      // the "search by what it does" path, kept weaker than name matches by
      // the scoring weights above.
      const exactLeaf = t.leaf.join(" ") === queryTokens.join(" ");
      if (exactLeaf || exactFull) return true;
      let described = 0;
      for (const token of queryTokens) if (t.description.includes(token)) described += 1;
      return covered * 2 >= queryTokens.length || described * 2 >= queryTokens.length;
    })
    .sort(byScoreThenName)
    .slice(0, boundedLimit);
}

// Candidate names for an UNKNOWN_TOOL error. Tolerates the exact failure
// shapes seen live: missing server segment (`mcp__list_concepts`), a mangled
// server fragment (`mcp__find_data-business-*`), separator corruption, and
// wildcard-only input. Returns full callable names only, bounded.
export function candidateToolNames(records, attemptedName, { limit = 5 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 5, 20));
  if (typeof attemptedName !== "string" || !attemptedName.trim()) return [];
  const tokens = normalizeTokens(attemptedName);
  if (!tokens.length) return []; // bare `mcp__`, wildcard-only, separators-only
  const results = searchToolRecords(records, { query: attemptedName, limit: bounded });
  // For a segment-shaped attempt (`a__b`, `mcp__x`), also try matching on the
  // TAIL segment alone — that is the "forgot the server" shape.
  const tail = attemptedName.includes("__") ? attemptedName.split("__").filter(Boolean).pop() : null;
  const tailResults = tail
    ? searchToolRecords(records, { query: tail, limit: bounded })
    : [];
  const seen = new Set();
  const out = [];
  for (const entry of [...results, ...tailResults]) {
    if (seen.has(entry.record.name)) continue;
    seen.add(entry.record.name);
    out.push(entry.record.name);
    if (out.length >= bounded) break;
  }
  return out;
}
