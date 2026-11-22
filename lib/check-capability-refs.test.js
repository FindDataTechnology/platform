// Tests for assembly-time capability check (change:
// wire-capability-catalog-into-pack-assembly, tasks 1.1/2.x/4.x).
// Run: node --test lib/check-capability-refs.test.js
//
// The check is pure over an injected catalog loader, so these tests pin its
// contract without a live catalog: reachable/missing refs, governor range,
// fail-closed on an unavailable catalog, and the degrade mode being visible.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCapabilityRefs,
  manifestToolRefs,
  describeRefFailures,
  activeCheckMode,
} from "./check-capability-refs.js";

const SERVING = {
  "price.close": [["fd-open-data-mcp", "read"]],
  "gdp.cn": [["fd-open-data-mcp", "read"], ["fd-find-data-business-mcp", "read_range"]],
};
const loader = (catalog) => async () => catalog;

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

test("real tool ref passes (no governor)", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["read"] }] },
    { loadCatalog: loader({ serving: SERVING, effective: null }) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
});

test("offline tool is missing and named", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["gone_tool"] }] },
    { loadCatalog: loader({ serving: SERVING, effective: null }) },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [{ server: "fd-open-data-mcp", tool: "gone_tool", pack: "p" }]);
  assert.match(describeRefFailures(r), /fd-open-data-mcp\.gone_tool not found/);
});

test("bare server ref needs the server to serve anything", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "not-a-server" }] },
    { loadCatalog: loader({ serving: SERVING, effective: null }) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.missing[0].tool, "*");
});

test("governed caller: out-of-range ref is 'unavailable', not existence-revealing", async () => {
  // governor may use fd-open-data-mcp.read (price.close) but NOT gdp.cn's
  // business edge; a ref outside range collapses into `unavailable` (opaque),
  // never `ungoverned`/`missing` (which would reveal existence).
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-find-data-business-mcp", allowTools: ["read_range"] }] },
    { loadCatalog: loader({ serving: SERVING, effective: ["price.close"] }) },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.unavailable, [
    { server: "fd-find-data-business-mcp", tool: "read_range", pack: "p" },
  ]);
  assert.equal(r.missing.length, 0); // no existence leak
  assert.equal(r.ungoverned.length, 0);
});

test("governed caller: nonexistent vs out-of-range are indistinguishable", async () => {
  // A truly-absent ref and an exists-but-outside-range ref yield the SAME shape
  // for a governed caller — neither reveals which it is.
  const absent = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "ghost-server", allowTools: ["x"] }] },
    { loadCatalog: loader({ serving: SERVING, effective: ["price.close"] }) },
  );
  const outOfRange = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-find-data-business-mcp", allowTools: ["read_range"] }] },
    { loadCatalog: loader({ serving: SERVING, effective: ["price.close"] }) },
  );
  assert.equal(absent.ok, outOfRange.ok);
  assert.deepEqual(absent.unavailable, [{ server: "ghost-server", tool: "x", pack: "p" }]);
  assert.deepEqual(outOfRange.unavailable, [{ server: "fd-find-data-business-mcp", tool: "read_range", pack: "p" }]);
  // both are just "unavailable", no finer reason
  assert.equal(absent.missing.length + absent.ungoverned.length, 0);
  assert.equal(outOfRange.missing.length + outOfRange.ungoverned.length, 0);
});

test("admin (no governor) sees precise missing vs ungoverned", async () => {
  // admin full view (effective null) may distinguish — it already sees all.
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["gone_tool"] }] },
    { loadCatalog: loader({ serving: SERVING, effective: null }) },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [{ server: "fd-open-data-mcp", tool: "gone_tool", pack: "p" }]);
  assert.equal(r.unavailable.length, 0);
});

test("catalog unavailable -> fail-closed by default", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["read"] }] },
    { loadCatalog: async () => { throw new Error("down"); } },
  );
  assert.equal(r.ok, false);
  assert.equal(r.catalogUnavailable, true);
  assert.equal(r.degraded, false);
});

test("catalog unavailable + degrade -> allowed but marked, never 'verified'", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [{ registryName: "fd-open-data-mcp", allowTools: ["read"] }] },
    { failClosed: false, loadCatalog: async () => { throw new Error("down"); } },
  );
  assert.equal(r.ok, true);
  assert.equal(r.catalogUnavailable, true);
  assert.equal(r.degraded, true); // visible: "not verified"
});

test("empty manifest has no refs -> ok", async () => {
  const r = await checkCapabilityRefs(
    { name: "p", mcpServers: [] },
    { loadCatalog: loader({ serving: SERVING, effective: null }) },
  );
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
