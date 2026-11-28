#!/usr/bin/env node
// ── Full-mode tool scope tests (full-mode-tool-scope tasks 1.1–1.5, 3.x) ─────
//
// Pure derivation: the installed-pack union, the safety valve (an undeclared
// or fullSurface reference contributes the whole surface — never an empty
// set), the per-server override, and a custom preset's declared/fallback face.
//
//   node --test scripts/test-full-mode-tool-scope.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { deriveFullModeToolScope, customPresetToolScope } = await import("../lib/full-mode-tool-scope.js");

const pack = (refs) => ({ manifest: { mcpServers: refs } });

test("two packs referencing one server contribute the union", () => {
  const scope = deriveFullModeToolScope([
    pack([{ registryName: "fd-quant", allowTools: ["compute_sma", "compute_ema"] }]),
    pack([{ registryName: "fd-quant", allowTools: ["compute_rsi", "compute_sma"] }]),
  ]);
  assert.deepEqual(scope["fd-quant"].sort(), ["compute_ema", "compute_rsi", "compute_sma"]);
});

test("a single pack narrows only its own server; unreferenced servers are absent", () => {
  const scope = deriveFullModeToolScope([pack([{ registryName: "srv-a", allowTools: ["read"] }])]);
  assert.deepEqual(scope, { "srv-a": ["read"] });
});

test("an undeclared reference contributes the full surface, never an empty set", () => {
  const scope = deriveFullModeToolScope([
    pack([{ registryName: "srv-a", allowTools: ["read"] }]),
    pack([{ registryName: "srv-a" }]),
  ]);
  assert.equal(scope, null, "the undeclared pack lifts the filter for srv-a");
  // The explicit shape the safety valve forbids:
  assert.ok(!Object.values(scope ?? {}).some((v) => Array.isArray(v) && v.length === 0));
});

test("an empty or malformed declaration is treated as undeclared (full surface)", () => {
  for (const ref of [
    { registryName: "srv-a", allowTools: [] },
    { registryName: "srv-a", allowTools: "read" },
    { registryName: "srv-a", allowTools: [42] },
  ]) {
    assert.equal(deriveFullModeToolScope([pack([ref])]), null, JSON.stringify(ref));
  }
});

test("a fullSurface marker contributes the full surface", () => {
  const scope = deriveFullModeToolScope([
    pack([{ registryName: "srv-a", fullSurface: true, fullSurfaceReason: "间接引用" }]),
  ]);
  assert.equal(scope, null);
});

test("no installed packs → null (byte-identical pre-change composition)", () => {
  assert.equal(deriveFullModeToolScope([]), null);
  assert.equal(deriveFullModeToolScope(undefined), null);
});

test("the per-server override lifts a narrowed server", () => {
  const scope = deriveFullModeToolScope(
    [pack([{ registryName: "srv-a", allowTools: ["read"] }, { registryName: "srv-b", allowTools: ["write"] }])],
    ["srv-b"],
  );
  assert.deepEqual(scope, { "srv-a": ["read"] });
});

test("a custom preset declares its own face, or inherits the union when absent", () => {
  const union = { "srv-a": ["read", "search"] };
  // Declared: exact set.
  assert.deepEqual(customPresetToolScope(["srv-a"], { "srv-a": ["read"] }, union), { "srv-a": ["read"] });
  // Absent: inherits the union.
  assert.deepEqual(customPresetToolScope(["srv-a"], {}, union), { "srv-a": ["read", "search"] });
  // No union and no declaration: absent = full surface.
  assert.equal(customPresetToolScope(["srv-a"], {}, null), null);
  // The override outranks the preset's narrowing.
  assert.equal(customPresetToolScope(["srv-a"], { "srv-a": ["read"] }, union, ["srv-a"]), null);
  // Servers the preset does not reference are never added.
  assert.equal(customPresetToolScope([], { "srv-a": ["read"] }, union), null);
  // Malformed declarations read as absent.
  assert.deepEqual(customPresetToolScope(["srv-a"], { "srv-a": [] }, union), { "srv-a": ["read", "search"] });
});
