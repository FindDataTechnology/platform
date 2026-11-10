#!/usr/bin/env node
// ── Connector binding rows for a served agent (add-deployment-binding-grant 3.x)
//
// A served agent has no session, so its connector binding arrives as a
// deployment secret minted at deploy time by the deployer. The descriptor says
// WHICH secret authenticates WHICH server; this helper turns that into dsh MCP
// rows — or into nothing, deliberately, when the value is missing.
//
// The refusal is the point: an unauthenticated connector row would look
// available and fail at call time, so a binding whose secret did not resolve is
// skipped instead.
//
//   node --test scripts/test-connector-binding-entries.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorBindingEntries } from "../agent-runner/compose.js";

const row = (over) => ({ serverName: "connector:pack:market", url: "https://connector.example.test/mcp", secretName: "connector_binding_market", ...over });

test("a resolved binding becomes one authenticated MCP row", () => {
  const entries = connectorBindingEntries([row()], { connector_binding_market: "oct_child" });
  assert.equal(entries.length, 1);
  // The row's id/serverName go through the mcp-client alphabet
  // (^[A-Za-z0-9_-]{1,32}$) — a colon name is refused by the plugin and the
  // server then never starts (measured 2026-11-09).
  assert.match(entries[0].id, /^mcp-[A-Za-z0-9_-]{1,32}$/);
  assert.match(entries[0].config.serverName, /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(entries[0].config.serverName, "connector_pack_market_7f873b95");
  assert.equal(entries[0].config.transport, "streamable-http");
  assert.equal(entries[0].config.url, "https://connector.example.test/mcp");
  assert.equal(entries[0].config.headers.Authorization, "Bearer oct_child");
});

test("a binding whose secret did not resolve is skipped, not emitted unauthenticated", () => {
  const entries = connectorBindingEntries([row()], {});
  assert.deepEqual(entries, []);

  const empty = connectorBindingEntries([row()], { connector_binding_market: "" });
  assert.deepEqual(empty, [], "an empty value is as unusable as a missing one");
});

test("malformed rows never produce a row", () => {
  const values = { connector_binding_market: "oct_child" };
  assert.deepEqual(connectorBindingEntries([row({ serverName: "" })], values), []);
  assert.deepEqual(connectorBindingEntries([row({ url: "" })], values), []);
  assert.deepEqual(connectorBindingEntries([row({ secretName: "" })], values), []);
  assert.deepEqual(connectorBindingEntries([null, 42, "x"], values), []);
});

test("no bindings at all is simply no rows", () => {
  assert.deepEqual(connectorBindingEntries(undefined, {}), []);
  assert.deepEqual(connectorBindingEntries([], {}), []);
  assert.deepEqual(connectorBindingEntries([row()], undefined), []);
});

test("several bindings of one agent each get their own row and token", () => {
  const entries = connectorBindingEntries(
    [row(), row({ serverName: "connector:pack:wms", url: "https://connector.example.test/mcp", secretName: "connector_binding_wms" })],
    { connector_binding_market: "oct_a", connector_binding_wms: "oct_b" },
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.config.headers.Authorization).sort(),
    ["Bearer oct_a", "Bearer oct_b"],
  );
});
