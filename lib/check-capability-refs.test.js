// Tests for the assembly-time MCP-reference check (change:
// wire-capability-catalog-into-pack-assembly, tasks 1.1/2.x/4.x).
// Run: node --test lib/check-capability-refs.test.js
//
// Authority is the registry server index (corrected 2026-11-23 — see the module
// header). The check is pure over an injected index loader, so these tests pin
// its contract without a live registry.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCapabilityRefs,
  manifestToolRefs,
  describeRefFailures,
  activeCheckMode,
} from "./check-capability-refs.js";

const INDEX = new Map([
  ["fd-open-data-mcp", { toolList: ["read", "read_series", "graph_search"] }],
  ["fd-find-data-business-mcp", { toolList: ["read", "read_range"] }],
]);
const loader = (index) => async () => index;

test("manifestToolRefs: allowTools lists each tool, bare server is *", () => {
  const refs = manifestToolRefs({
    mcpServers: [
      { registryName: "fd-open-data-mcp", allowTools: ["read", "read_series"] },
      { registryName: "law-bench" },
    ],
  });
  assert.deepEqual(refs, [
    ["fd-open-data-mcp", "read"],
    ["fd-open-data-mcp", "read_series"],
    ["law-bench", "*"],
  ]);
});

test("real tool ref passes", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["read"] }] },
    { loadIndex: loader(INDEX) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
});

test("tool the server no longer exposes is missing and named", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["gone_tool"] }] },
    { loadIndex: loader(INDEX) },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [{ server: "fd-open-data-mcp", tool: "gone_tool", pack: "p" }]);
  assert.match(describeRefFailures(r), /fd-open-data-mcp\.gone_tool not exposed/);
});

test("a server the index does not know is a local binding -> exempt", async () => {
  // chatwoot / fleet-architect / fd-memory are not registry entries; their
  // surfaces live inside the cell. Deprecated refusal here was 104/104 live
  // packs (2026-11-23 measurement). Absence of the name is NOT evidence.
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "chatwoot", allowTools: ["nonexistent_tool"] }] },
    { loadIndex: loader(INDEX) },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test("bare server ref against a known server always passes (surface not narrowed)", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp" }] },
    { loadIndex: loader(INDEX) },
  );
  assert.equal(r.ok, true);
});

test("index unavailable -> fail-closed by default", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["read"] }] },
    { loadIndex: async () => { throw new Error("down"); } },
  );
  assert.equal(r.ok, false);
  assert.equal(r.catalogUnavailable, true);
  assert.equal(r.degraded, false);
});

test("index unavailable + degrade -> allowed but marked, never 'verified'", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["read"] }] },
    { failClosed: false, loadIndex: async () => { throw new Error("down"); } },
  );
  assert.equal(r.ok, true);
  assert.equal(r.catalogUnavailable, true);
  assert.equal(r.degraded, true); // visible: "not verified"
});

test("empty manifest has no refs -> ok", async () => {
  const r = await checkCapabilityRefs({ name: "p", mcpServers: [] }, { loadIndex: loader(INDEX) });
  assert.equal(r.ok, true);
});

test("default loader (empty index) refuses nothing — no false positives offline", async () => {
  // Without a live registry every name reads as a local binding: the gate stays
  // silent rather than inventing a verdict. Fail-closed applies to index
  // FETCH failure (above), not to an empty-but-real index.
  const r = await checkCapabilityRefs({
    name: "p",
    mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["gone_tool"] }],
  });
  assert.equal(r.ok, true);
});

test("activeCheckMode: off/unset/garbage all mean skip (byte-for-byte prior)", () => {
  assert.equal(activeCheckMode(undefined), null);
  assert.equal(activeCheckMode(""), null);
  assert.equal(activeCheckMode("off"), null);
  assert.equal(activeCheckMode("banana"), null);
  assert.equal(activeCheckMode("warn"), "warn");
  assert.equal(activeCheckMode("ENFORCE"), "enforce");
});
