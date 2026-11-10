#!/usr/bin/env node
// ── Injection-surface accounting (trim-mcp-injection-per-post 1.1) ──────────
//
// The cell composes ONE mcp.patch.yml for every persona, so the number of
// servers it carries is exactly the schema bill every turn pays. Live
// 2026-11-09 the owner cell carried 34 servers while a single post referenced
// 2–3. Nobody had a number to look at — and the context growth caused by that
// headroom loss was misdiagnosed three times before the data settled.
//
// These tests pin the counting contract, including its refusal to invent
// numbers it was not given.
//
//   node --test scripts/test-injection-surface.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { summarizeInjectionSurface, describeInjectionSurface } = await import(
  path.join(here, "../lib/injection-surface.js")
);

test("1. counts the servers it was given (the live 34-server cell)", () => {
  const names = [
    "facet-market", "wire-ops", "lex-ops", "fd-erp-ledger-mcp", "actions", "fleet",
    "bench-proposal", "library", "cron", "delegation", "airegistry-tools", "blueprint-author",
    "chatwoot", "facet-market-mcp", "facet-ops-mcp", "fd-cn-report", "fd-daas-mcp",
    "fd-find-data-business-mcp", "fd-info", "fd-open-data-mcp", "fd-quant", "fd-sentiment",
    "fd-text-core", "fleet-architect", "infra-telemetry", "pack-author", "persona-evolution",
    "playwright", "skill-evolution", "websearch", "wire-build-mcp", "wire-ops-mcp",
    "connector_chat_explore_ba29f742", "fd-memory",
  ];
  assert.equal(summarizeInjectionSurface({ serverNames: names, skillRoots: 23 }).servers, 34);
  assert.equal(summarizeInjectionSurface({ serverNames: names, skillRoots: 23 }).skillRoots, 23);
});

test("2. empty / falsy names are not counted as servers", () => {
  const out = summarizeInjectionSurface({ serverNames: ["a", "", null, undefined, "b"], skillRoots: 0 });
  assert.equal(out.servers, 2);
});

test("3. a non-numeric or negative skill-root count reads as 0, never as NaN", () => {
  assert.equal(summarizeInjectionSurface({ serverNames: [], skillRoots: "many" }).skillRoots, 0);
  assert.equal(summarizeInjectionSurface({ serverNames: [], skillRoots: -3 }).skillRoots, 0);
});

test("4. no input at all is a valid, empty surface (composition may run before skills exist)", () => {
  assert.deepEqual(summarizeInjectionSurface(), { servers: 0, skillRoots: 0 });
});

test("5. the log line carries both numbers and nothing invented", () => {
  const line = describeInjectionSurface({ serverNames: ["a", "b", "c"], skillRoots: 7 });
  assert.equal(line, "3 MCP server(s), 7 skill root(s)");
  assert.ok(!/\d+%|token|estimat/i.test(line), "no fabricated cost estimate rides the line");
});

test("6. fractional skill roots are floored (a count is an integer)", () => {
  assert.equal(summarizeInjectionSurface({ serverNames: [], skillRoots: 6.9 }).skillRoots, 6);
});
