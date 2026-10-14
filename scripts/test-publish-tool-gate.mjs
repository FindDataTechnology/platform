#!/usr/bin/env node
// ── Publish tool-gate tests (add-mcp-tool-scoping, tasks 5.1–5.3) ────────────
//
// Exercises the pure gate (existence with probe fallback, commercial
// closure, local-ref exemption, declaration collection) and the minimal
// streamable-http probe against a stubbed wire. registryServerIndex gets an
// override-fetch test (mapping + cache).
//
//   node --test scripts/test-publish-tool-gate.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { declaredToolsByServer, toolGateErrors, probeMcpToolNames } = await import("../lib/publish-tool-gate.js");
const { registryServerIndex } = await import("../registry-bridge.js");

const manifestWith = (mcpServers, agents = []) => ({
  name: "门测试包",
  mcpServers,
  agents: agents.length ? agents : [{ id: "a1", name: "甲", persona: "p" }],
});

test("declaration collection unions pack-level and role-level names", () => {
  const m = manifestWith(
    [{ registryName: "srv-a", allowTools: ["read", "search"] }],
    [{ id: "r1", name: "R", persona: "p", resources: { mcpTools: { "srv-a": ["read", "purge"] } } }],
  );
  assert.deepEqual(
    [...declaredToolsByServer(m).get("srv-a")].sort(),
    ["purge", "read", "search"],
  );
  // Nothing declared anywhere: empty map (the gate is never consulted).
  assert.equal(declaredToolsByServer(manifestWith([{ registryName: "srv-a" }])).size, 0);
});

const info = (toolList, extra = {}) => ({ toolList, commercialTools: null, endpoint: "http://x/mcp", ...extra });

test("names missing from the snapshot fail when no probe is available", async () => {
  const { errors } = await toolGateErrors(
    manifestWith([{ registryName: "srv-a", allowTools: ["read", "ghost_tool"] }]),
    () => info(["read"]),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /srv-a/);
  assert.match(errors[0].error, /ghost_tool/);
  assert.equal(errors[0].entry, "mcpServers:srv-a");
});

test("snapshot staleness falls back to a live probe; probe-missed names still fail", async () => {
  let probed = 0;
  const probe = async () => {
    probed += 1;
    return ["read", "fresh_tool"]; // fresh_tool lives, ghost_tool does not
  };
  const { errors, notes } = await toolGateErrors(
    manifestWith([{ registryName: "srv-a", allowTools: ["read", "fresh_tool", "ghost_tool"] }]),
    () => info(["read"]),
    { probe },
  );
  assert.equal(probed, 1, "one bounded probe per server");
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /ghost_tool/);
  assert.ok(!/fresh_tool/.test(errors[0].error), "the probe-confirmed name passed");
  assert.ok(notes.some((n) => /confirmed by live probe/.test(n)));
});

test("an unavailable probe leaves the name unresolved, not absent (actionable refusal)", async () => {
  // A billing-gated / unreachable server must not be reported as "the tool
  // does not exist" — the author can act on a refresh instruction.
  const probe = async () => null;
  const { errors, notes } = await toolGateErrors(
    manifestWith([{ registryName: "srv-a", allowTools: ["fresh_tool"] }]),
    () => info(["read"]),
    { probe },
  );
  assert.equal(errors.length, 1, "an unverifiable declaration still refuses");
  assert.match(errors[0].error, /fresh_tool/);
  assert.match(errors[0].error, /unresolved rather than absent/);
  assert.match(errors[0].error, /refresh the registry entry's tool_list snapshot/);
  assert.ok(!/does not expose/.test(errors[0].error), "never asserts the tool is gone");
  assert.ok(notes.some((n) => /unavailable/.test(n)));
});

test("commercial closure fails declared-but-existing internal tools", async () => {
  const probe = async () => ["read", "internal_tool"]; // exists live…
  const { errors } = await toolGateErrors(
    manifestWith([{ registryName: "srv-a", allowTools: ["read", "internal_tool"] }]),
    () => info(["read", "internal_tool"], { commercialTools: ["read"] }), // …but not commercial
    { probe },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /commercial/);
  assert.match(errors[0].error, /internal_tool/);
});

test("counts-only surface metadata skips closure with an observable note", async () => {
  const { errors, notes } = await toolGateErrors(
    manifestWith([{ registryName: "srv-a", allowTools: ["read"] }]),
    () => info(["read"], { commercialTools: "counts-only", surfaceCountsOnly: true }),
  );
  assert.equal(errors.length, 0);
  assert.ok(notes.some((n) => /closure skipped/.test(n)));
});

test("non-registry names are exempt (local-binding contract)", async () => {
  let consulted = 0;
  const { errors, notes } = await toolGateErrors(
    manifestWith([{ registryName: "my-private-mcp", allowTools: ["whatever_tool"] }]),
    () => {
      consulted += 1;
      return null; // not in the registry index
    },
  );
  assert.equal(errors.length, 0);
  assert.ok(notes.some((n) => /local binding contract/.test(n)));
  assert.equal(consulted, 1);
});

// ── probeMcpToolNames against a stubbed streamable-http wire ─────────────────
function stubWire() {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const headers = { "Content-Type": "application/json" };
    if (body.method === "initialize") {
      headers["Mcp-Session-Id"] = "sess-1";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "x" } } }), { headers });
    }
    if (body.method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "read" }, { name: "search.legal" }] } }),
      { headers },
    );
  };
  return { fetchImpl, calls };
}

test("probe walks initialize → initialized → tools/list and reads names", async () => {
  const { fetchImpl, calls } = stubWire();
  const names = await probeMcpToolNames("http://reg.example/srv-a/mcp", { fetchImpl });
  assert.deepEqual(names, ["read", "search.legal"]);
  assert.deepEqual(calls.map((c) => c.method), ["initialize", "notifications/initialized", "tools/list"]);
});

test("probe tolerates SSE-framed replies and fails soft", async () => {
  const sseBody = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
  const fetchImpl = async (_u, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      return new Response(sseBody({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }), {
        headers: { "Mcp-Session-Id": "s", "Content-Type": "text/event-stream" },
      });
    }
    if (body.method === "tools/list") {
      return new Response(sseBody({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "read" }] } }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response("", { status: 202 });
  };
  assert.deepEqual(await probeMcpToolNames("http://x/mcp", { fetchImpl }), ["read"]);
  // Any wire failure → null, never a throw.
  const dead = async () => new Response("nope", { status: 500 });
  assert.equal(await probeMcpToolNames("http://x/mcp", { fetchImpl: dead }), null);
});

// ── registryServerIndex mapping (override fetch) ─────────────────────────────
test("registry tool_list entries are tool objects; the index maps them to names", async () => {
  // Production shape: tool_list carries {name, description, schema} objects —
  // a String() coercion would yield "[object Object]" and break every name
  // comparison downstream.
  const { toolListNames } = await import("../registry-bridge.js");
  const objects = [
    { name: "read", description: "d", schema: { type: "object" } },
    { name: "search", description: "d" },
  ];
  assert.deepEqual(toolListNames(objects), ["read", "search"]);
  assert.equal(toolListNames(null), null);
  assert.equal(toolListNames([]), null);
  assert.deepEqual(toolListNames(["plain_name"]), ["plain_name"], "tolerate the legacy string shape");

  const idx = await registryServerIndex({
    fetchImpl: async () => ({ servers: [{ path: "/obj-srv-a", tool_list: objects }] }),
  });
  assert.deepEqual(idx.get("obj-srv-a").toolList, ["read", "search"]);
});
test("registryServerIndex maps snapshots, surfaces, and endpoints; caches", async () => {
  let fetches = 0;
  const doc = {
    servers: [
      {
        path: "/idx-srv-a",
        tool_list: ["read", "search"],
        metadata: { surface: { commercial_tools: ["read"], tools_commercial: 1, tools_total: 2 } },
      },
      { path: "/idx-srv-b", tool_list: ["x"], metadata: { surface: { tools_commercial: 1, tools_total: 1 } } },
      { path: "/idx-srv-c", is_enabled: false },
      { path: "/idx-srv-d" },
    ],
  };
  const fetchImpl = async () => {
    fetches += 1;
    return doc;
  };
  // The cache is module-level, so force a fresh fetch for a deterministic start.
  await registryServerIndex({ fetchImpl, maxAgeMs: 0 });
  const fetchesAfterWarm = fetches;
  const idx = await registryServerIndex({ fetchImpl });
  assert.equal(fetches, fetchesAfterWarm, "within the TTL the index is served without a refetch");
  const a = idx.get("idx-srv-a");
  assert.deepEqual(a.toolList, ["read", "search"]);
  assert.deepEqual(a.commercialTools, ["read"]);
  assert.equal(a.surfaceCountsOnly, false);
  assert.match(a.endpoint, /\/idx-srv-a\/mcp$/);
  const b = idx.get("idx-srv-b");
  assert.equal(b.commercialTools, null);
  assert.equal(b.surfaceCountsOnly, true, "counts-only shape is marked, not guessed");
  assert.ok(!idx.has("idx-srv-c"), "disabled entries are skipped");
  assert.equal(idx.get("idx-srv-d").toolList, null, "no snapshot → null, gate probes");
  const fresh = await registryServerIndex({ fetchImpl, maxAgeMs: 0 });
  assert.equal(fetches, fetchesAfterWarm + 1, "maxAgeMs: 0 forces a refetch");
  assert.ok(fresh.get("idx-srv-a"));
});
