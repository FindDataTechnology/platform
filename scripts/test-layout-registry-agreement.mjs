// Registry ↔ Settings-definitions agreement (openspec: restructure-yizuo-ia,
// layout-configuration `Unified surface registry`).
//
// The Settings modal renders ONLY server-resolved slugs, so a section that
// exists in `sections.ts` but not in the surface registry is permanently
// unreachable — that is exactly how `delegation` (委托策略) disappeared. The
// invariant is bidirectional: every definition has a registry entry with the
// same slug, and every registry slug has a definition.
//
// `sections.ts` imports React components (lazy + lucide icons), so it cannot be
// imported by the node test runner. The canonical slugs are read from source
// text instead: `slug:` with a quoted literal is the definition's own key
// (the interface's `slug: string;` is unquoted).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SETTINGS_SURFACES } from "../packages/core/src/lib/surfaces.ts";

const SECTIONS_TS = new URL("../web/src/components/settings/sections.ts", import.meta.url);

function definitionSlugs() {
  const src = readFileSync(SECTIONS_TS, "utf8");
  const out = [];
  for (const m of src.matchAll(/^\s*slug:\s*"([^"]+)",/gm)) out.push(m[1]);
  return out;
}

test("every Settings definition has a registry entry with the same slug", () => {
  const registry = new Set(SETTINGS_SURFACES.map((s) => s.slug));
  const missing = definitionSlugs().filter((slug) => !registry.has(slug));
  assert.deepEqual(
    missing,
    [],
    `sections.ts defines ${missing.join(", ")} but the surface registry does not — the modal renders only registry slugs, so these would be unreachable`,
  );
});

test("every Settings registry slug has exactly one definition", () => {
  const slugs = definitionSlugs();
  const dupes = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
  assert.deepEqual(dupes, [], "duplicate section slugs");
  const defined = new Set(slugs);
  const orphans = SETTINGS_SURFACES.map((s) => s.slug).filter((slug) => !defined.has(slug));
  assert.deepEqual(orphans, [], `registry carries ${orphans.join(", ")} with no section definition — it would render an empty pane`);
});

test("known-unreachable case stays closed: delegation is in both lists", () => {
  // Regression pin for the bug this invariant exists for.
  assert.ok(SETTINGS_SURFACES.some((s) => s.slug === "delegation"));
  assert.ok(definitionSlugs().includes("delegation"));
});
