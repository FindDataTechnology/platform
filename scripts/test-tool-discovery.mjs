// Unit tests for server/tool-discovery.js — the shared matcher behind the
// `tool_search` dsh tool and the host-side UNKNOWN_TOOL candidate enrichment.
// Run: node --test scripts/test-tool-discovery.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseToolSchema,
  parseToolSchemas,
  normalizeTokens,
  searchToolRecords,
  candidateToolNames,
} from "../server/tool-discovery.js";

const ROSTER = [
  {
    name: "read",
    description: "Read a file from the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "grep",
    description: "Search file contents with a regex.",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  {
    name: "mcp__fd-open-data-mcp__list_concepts",
    description: "List economic concepts available in the open data catalog.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "mcp__fd-find-data-business-mcp__list_concepts",
    description: "List business data concepts including World Bank topic trees.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "mcp__fd-find-data-business-mcp__wb_search_indicators",
    description: "Search World Bank indicators by keyword such as GDP.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "mcp__fd-open-data-mcp__get_entity",
    description: "Resolve an entity such as a country by code.",
    parameters: {
      type: "object",
      properties: { code: { type: "string" }, entity_type: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "mcp__law-bench__law_types",
    description: "List supported contract types for legal drafting.",
    parameters: { type: "object", properties: {} },
  },
];

const records = () => parseToolSchemas(ROSTER);

test("parseToolSchema splits MCP names into server and leaf", () => {
  const rec = parseToolSchema({
    name: "mcp__fd-open-data-mcp__list_concepts",
    description: "d",
    parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  });
  assert.equal(rec.origin, "mcp");
  assert.equal(rec.server, "fd-open-data-mcp");
  assert.equal(rec.leaf, "list_concepts");
  assert.deepEqual(rec.required, ["a"]);
  assert.equal(rec.properties.a.type, "string");
});

test("parseToolSchema keeps built-in tools local with no server split", () => {
  const rec = parseToolSchema({ name: "grep", description: "x", parameters: {} });
  assert.equal(rec.origin, "local");
  assert.equal(rec.server, null);
  assert.equal(rec.leaf, "grep");
});

test("parseToolSchemas drops malformed entries", () => {
  const out = parseToolSchemas([null, {}, { name: "" }, { name: "ok" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "ok");
});

test("normalizeTokens strips separators, wildcards, and the mcp token", () => {
  assert.deepEqual(normalizeTokens("mcp__list_concepts"), ["list", "concepts"]);
  assert.deepEqual(normalizeTokens("mcp__find_data-business-*"), ["find", "data", "business"]);
  assert.deepEqual(normalizeTokens("LIST-concepts"), ["list", "concepts"]);
  assert.deepEqual(normalizeTokens("mcp__"), []);
  assert.deepEqual(normalizeTokens("***"), []);
  assert.deepEqual(normalizeTokens(42), []);
});

test("search finds exact full name and ranks it first", () => {
  const [top] = searchToolRecords(records(), { query: "mcp__fd-open-data-mcp__get_entity" });
  assert.equal(top.record.name, "mcp__fd-open-data-mcp__get_entity");
});

test("leaf-only query returns every server's duplicate leaf, uncollapsed", () => {
  const hits = searchToolRecords(records(), { query: "list_concepts" });
  const names = hits.map((h) => h.record.name);
  assert.ok(names.includes("mcp__fd-open-data-mcp__list_concepts"));
  assert.ok(names.includes("mcp__fd-find-data-business-mcp__list_concepts"));
});

test("malformed server fragment still finds the right server's tools", () => {
  const hits = searchToolRecords(records(), { query: "find_data-business list concepts" });
  const names = hits.map((h) => h.record.name);
  assert.ok(
    names.includes("mcp__fd-find-data-business-mcp__list_concepts"),
    `expected business server hit, got ${JSON.stringify(names)}`,
  );
});

test("server-scoped search ranks that server's match first", () => {
  const [top] = searchToolRecords(records(), {
    query: "GDP indicator search",
    server: "fd-find-data-business-mcp",
  });
  assert.equal(top.record.server, "fd-find-data-business-mcp");
  assert.equal(top.record.name, "mcp__fd-find-data-business-mcp__wb_search_indicators");
});

test("unrelated query returns no fabricated match", () => {
  const hits = searchToolRecords(records(), { query: "zzzqqq unrelated" });
  assert.deepEqual(hits, []);
});

test("results are bounded by limit", () => {
  const hits = searchToolRecords(records(), { query: "mcp", limit: 2 });
  assert.ok(hits.length <= 2);
  // With only a server filter, listing is allowed (server-only browse).
  const listed = searchToolRecords(records(), { query: "", server: "law-bench" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].record.name, "mcp__law-bench__law_types");
});

test("matcher does not mutate its inputs", () => {
  const roster = records();
  const snapshot = JSON.stringify(roster);
  searchToolRecords(roster, { query: "mcp__find_data-business-*" });
  candidateToolNames(roster, "mcp__list_concepts");
  assert.equal(JSON.stringify(roster), snapshot);
  const query = Object.freeze("mcp__FIND_DATA-BUSINESS-*");
  assert.doesNotThrow(() => searchToolRecords(roster, { query }));
});

test("candidates: missing server segment resolves to exact full names", () => {
  const cands = candidateToolNames(records(), "mcp__list_concepts");
  assert.ok(cands.includes("mcp__fd-open-data-mcp__list_concepts"));
  assert.ok(cands.includes("mcp__fd-find-data-business-mcp__list_concepts"));
  for (const c of cands) assert.match(c, /^mcp__[^_]+__/);
});

test("candidates: malformed server fragment finds business-server tools", () => {
  const cands = candidateToolNames(records(), "mcp__find_data-business");
  assert.ok(
    cands.some((c) => c.startsWith("mcp__fd-find-data-business-mcp__")),
    `got ${JSON.stringify(cands)}`,
  );
});

test("candidates: no credible overlap yields empty, never fabricated names", () => {
  assert.deepEqual(candidateToolNames(records(), "mcp__"), []);
  assert.deepEqual(candidateToolNames(records(), "mcp__***"), []);
  assert.deepEqual(candidateToolNames(records(), "totally_unrelated_zzz"), []);
  assert.deepEqual(candidateToolNames(records(), ""), []);
});

test("candidates: wildcard-only tail still matches via token coverage", () => {
  const cands = candidateToolNames(records(), "mcp__law-bench__*");
  assert.ok(cands.includes("mcp__law-bench__law_types"));
});
