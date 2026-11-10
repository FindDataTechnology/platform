#!/usr/bin/env node
// ── Builtin-capability reference gate tests
//    (enable-constructor-skill-authoring / D8 ② 校验面) ────────────────────────
//
// Pins the fix for the 2026-11-08 live defect: a pack referencing a platform
// capability (`propose_action` on `actions-mcp`) published GREEN and only
// degraded to `awaiting-local-binding` at install time, because every
// non-registry name was exempted as a "local binding".
//
// The gate now distinguishes three cases for a name the registry does not know:
//   builtin (in platform.bundle.json)  → exempt, as before
//   not builtin + mode=enforce         → publish rejected
//   not builtin + mode=warn (default)  → published, but a warning is emitted
//   mode=off                           → legacy behaviour (silent exempt)
//
//   node --test scripts/test-publish-builtin-ref-gate.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { toolGateErrors } = await import(path.join(here, "../lib/publish-tool-gate.js"));

// The registry knows nothing in these tests; the builtin set is explicit.
const noRegistry = () => null;
const manifestWith = (...servers) => ({
  name: "gate-sample",
  mcpServers: servers.map((n) => ({ registryName: n, allowTools: ["t"] })),
});

test("builtin capability is exempt (propose_action rides the bundle)", async () => {
  const out = await toolGateErrors(manifestWith("actions-mcp"), noRegistry, {
    isBuiltinServer: (n) => n === "actions-mcp",
    builtinRefMode: "enforce",
  });
  assert.deepEqual(out.errors, []);
  assert.match(out.notes.join("\n"), /bundled platform capability/);
});

test("unknown name is rejected in enforce mode", async () => {
  const out = await toolGateErrors(manifestWith("not_a_real_server"), noRegistry, {
    isBuiltinServer: () => false,
    builtinRefMode: "enforce",
  });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /neither a registry entry nor a bundled platform capability/);
  assert.equal(out.errors[0].entry, "mcpServers:not_a_real_server");
});

test("unknown name only warns in the default mode", async () => {
  const warnings = [];
  const out = await toolGateErrors(manifestWith("not_a_real_server"), noRegistry, {
    isBuiltinServer: () => false,
    builtinRefMode: "warn",
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(out.errors, []);
  // The gate also echoes every note through logger.warn at the end, so the
  // discriminating assertion is the message itself, not the call count.
  assert.ok(warnings.some((m) => /can never bind at install time/.test(m)));
});

test("off mode keeps the legacy silent exemption", async () => {
  const warnings = [];
  const out = await toolGateErrors(manifestWith("not_a_real_server"), noRegistry, {
    isBuiltinServer: () => false,
    builtinRefMode: "off",
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(out.errors, []);
  assert.equal(warnings.some((m) => /can never bind at install time/.test(m)), false);
  assert.match(out.notes.join("\n"), /local binding contract/);
});

test("no isBuiltinServer keeps pre-change behaviour byte-for-byte", async () => {
  const out = await toolGateErrors(manifestWith("anything"), noRegistry, {});
  assert.deepEqual(out.errors, []);
  assert.match(out.notes.join("\n"), /local binding contract/);
});
