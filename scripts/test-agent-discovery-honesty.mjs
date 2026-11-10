// Agent discovery must not lie about its own size (fix-agent-discovery-honesty).
//
// `/api/delegation/agents` sliced matches at 8 with no total and no signal, and
// `search_agents` printed that slice's length as "Online market agents (8)" —
// so a keyword matching 30 agents answered "8" and the delegating model picked
// from an arbitrary slice while believing it had enumerated the market. The
// slice order was also the catalog's scan order: two identical calls could
// return different agents.
//
// Run: node --test scripts/test-agent-discovery-honesty.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

// server/agent-discovery.js is the one definition both faces use; the MCP
// module itself spawns a stdio server at import, so a unit test cannot reach
// the formatter through it.
const { searchAgentsView, formatSearchAgentsText, AGENT_SEARCH_LIMIT, AGENT_SEARCH_MAX } = await import("../server/agent-discovery.js");

const agent = (n, extra = {}) => ({
  id: `a${n}`,
  name: `Agent ${String(n).padStart(2, "0")}`,
  description: `financial analyst ${n}`,
  category: "finance",
  tags: ["fin"],
  ...extra,
});
const many = (n) => Array.from({ length: n }, (_, i) => agent(i + 1));

test("被截断时必须说出真实匹配数", () => {
  const view = searchAgentsView({ all: many(12), search: "fin" });
  assert.equal(view.agents.length, AGENT_SEARCH_LIMIT, "default page stays 8");
  assert.equal(view.total, 12, "total is the MATCH count, not the page size");
  assert.equal(view.truncated, true);
});

test("未截断时 truncated=false，且 total 等于条数", () => {
  const view = searchAgentsView({ all: many(3), search: "fin" });
  assert.equal(view.agents.length, 3);
  assert.equal(view.total, 3);
  assert.equal(view.truncated, false);
});

test("limit 可放大页，但有上界", () => {
  assert.equal(searchAgentsView({ all: many(12), limit: "20" }).agents.length, 12, "limit=20 reaches all 12");
  assert.equal(searchAgentsView({ all: many(12), limit: "20" }).truncated, false);
  assert.equal(searchAgentsView({ all: many(80), limit: "999" }).agents.length, AGENT_SEARCH_MAX, "clamped to the ceiling");
  assert.equal(searchAgentsView({ all: many(12), limit: "0" }).agents.length, AGENT_SEARCH_LIMIT, "0 is not a page size");
  assert.equal(searchAgentsView({ all: many(12), limit: "abc" }).agents.length, AGENT_SEARCH_LIMIT, "garbage falls back");
  assert.equal(searchAgentsView({ all: many(12), limit: "-3" }).agents.length, AGENT_SEARCH_LIMIT);
});

test("顺序确定：同一集合任意输入顺序都得到同一页", () => {
  const a = searchAgentsView({ all: many(12), search: "fin" }).agents.map((x) => x.id);
  const shuffled = [...many(12)].reverse();
  const b = searchAgentsView({ all: shuffled, search: "fin" }).agents.map((x) => x.id);
  assert.deepEqual(a, b, "the page must not depend on the catalog's scan order");
  // And it is the FIRST 8 in that stable order, not an arbitrary slice.
  assert.deepEqual(a, ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"], "the first page in name order (names are zero-padded)");
});

test("空关键词列出前 N 且仍报真实总数；零匹配为空", () => {
  const all = searchAgentsView({ all: many(12), search: "" });
  assert.equal(all.agents.length, 8);
  assert.equal(all.total, 12);
  const none = searchAgentsView({ all: many(12), search: "no-such-thing" });
  assert.deepEqual([none.agents.length, none.total, none.truncated], [0, 0, false]);
});

test("工具文案：截断页说「showing 8 of 12」，未截断说真实条数", () => {
  const capped = formatSearchAgentsText({ agents: many(8), total: 12, truncated: true });
  assert.match(capped, /showing 8 of 12 matches/);
  assert.match(capped, /Narrow the keyword/, "the caller is told how to reach the rest");
  assert.ok(!/Online market agents \(8\)/.test(capped), "never presents the page as the market");

  const full = formatSearchAgentsText({ agents: many(3), total: 3, truncated: false });
  assert.match(full, /Online market agents \(3\)/);
  assert.ok(!full.includes("Narrow the keyword"));

  assert.match(formatSearchAgentsText({ agents: [], total: 0, truncated: false }), /No online market agents match/);
});
