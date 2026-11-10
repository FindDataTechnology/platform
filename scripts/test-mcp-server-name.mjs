#!/usr/bin/env node
// ── MCP server names must survive the mcp-client plugin's own validation ────
//
// Measured live 2026-11-09 on dsh 0.2.0-rc.2: `@deepseek-ai/dsh-mcp-client`
// validates `serverName` against `^[A-Za-z0-9_-]{1,32}$`. The connector binding
// rows used `connector:<pack>:<key>` (colons, 38 chars), so the plugin refused
// the config — and because the row is inserted with `failOnStartupError: false`
// the server never started and the post simply had no connector tools. Every
// artifact on disk looked right (patch row, pinned token, plugin package), which
// is exactly why this needs a test rather than another live drill to catch it.
//
// The invariant, both sides: a generated name is legal, stable, unique per slot,
// and resolvable back to its slot through the SAME definition (never by parsing).
//
//   node --test --test-force-exit scripts/test-mcp-server-name.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import * as bindings from "../connector-bindings.js";
import { compliantServerName } from "../agent-runner/compose.js";

// The plugin's own rule (lib/index.js: SERVER_NAME_PATTERN).
const LEGAL = /^[A-Za-z0-9_-]{1,32}$/;

const SLOTS = [
  "chat:explore",
  "7f7V7gNTX85b12Uwog9LXg:market",
  "qWlY4rrXowgN9aP_ueerWQ:market",
  "a".repeat(120) + ":key",
  "包:绑定",
];

test("every binding name is legal for the mcp-client plugin", () => {
  for (const slot of SLOTS) {
    const name = bindings.bindingServerName(slot);
    assert.match(name, LEGAL, `${JSON.stringify(slot)} -> ${name}`);
  }
});

test("names are stable, and two slots never collide", () => {
  assert.equal(bindings.bindingServerName("chat:explore"), bindings.bindingServerName("chat:explore"));
  const names = SLOTS.map((s) => bindings.bindingServerName(s));
  assert.equal(new Set(names).size, names.length, `collision among ${names.join(", ")}`);
  // The fold is lossy on purpose — the hash is what keeps them apart.
  const folded = ["p:same-key", "p/same/key", "p same key"].map((s) => bindings.bindingServerName(s));
  assert.equal(new Set(folded).size, 3);
});

test("the slot is recoverable through the same definition, never by parsing", () => {
  for (const slot of SLOTS) {
    const name = bindings.bindingServerName(slot);
    assert.equal(bindings.slotForServerName(name, SLOTS), slot);
  }
  assert.equal(bindings.slotForServerName("connector_not_one_of_ours_00000000", SLOTS), null);
  // A legacy colon name must not resolve — those rows are dead on this dsh.
  assert.equal(bindings.slotForServerName("connector:chat:explore", SLOTS), null);
});

test("the runner tightens names it did not generate", () => {
  for (const raw of ["connector:pack:market", "ok-name", "x".repeat(50), "带空格 的名字", ""]) {
    const name = compliantServerName(raw);
    assert.match(name, LEGAL, `${JSON.stringify(raw)} -> ${name}`);
  }
  // A legal name is passed through untouched (no churn on already-good rows).
  assert.equal(compliantServerName("connector_chat_explore_ba29f742"), "connector_chat_explore_ba29f742");
  assert.notEqual(compliantServerName("connector:pack:market"), compliantServerName("connector:pack:other"));
});
