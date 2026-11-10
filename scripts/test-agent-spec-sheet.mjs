#!/usr/bin/env node
// ── Agent spec-sheet tests (add-agent-spec-sheet) ────────────────────────────
//
// Pins the shared presentation contract by source assertion (the repo's
// component-test convention — web has no DOM test runner; e2e anchors the
// rendered surface):
//   1. the sheet NEVER imports packGuides (guide copy comes from document
//      data only — no client fallback inside the component)
//   2. the sheet NEVER re-derives badge/provenance (no deriveBadge import,
//      no structure-sniffing — it renders pre-derived values)
//   3. the three buckets render UNCONDITIONALLY with explicit empty states
//      (empty markers sit outside any length conditional)
//   4. the guide block renders ONLY when guide data is passed
//   5. consumers: PackDetailDialog (full, prefix=pack) and AssistantPicker
//      (compact) both consume the SAME component
//   6. the legacy e2e anchors survive: prefix "pack" reproduces
//      pack-skill-*, pack-mcp-tool-face-*, pack-guide-card, pack-agent-serving-*
//
//   node --test scripts/test-agent-spec-sheet.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const sheet = read("web/src/components/packs/AgentSpecSheet.tsx");
const dialog = read("web/src/components/packs/PackDetailDialog.tsx");
const picker = read("web/src/components/AssistantPicker.tsx");

test("sheet never imports packGuides (guide from document data only)", () => {
  assert.ok(!sheet.includes('@/lib/packGuides'), "AgentSpecSheet must not import @/lib/packGuides");
  assert.ok(!sheet.includes("guideFor"), "no guideFor fallback inside the component");
  // guide block is data-conditional: renders only when guide is truthy
  assert.match(sheet, /\{guide && guide\.steps\.length > 0 && \(/, "guide block gated on passed data");
});

test("sheet re-derives nothing (badge/provenance arrive pre-derived)", () => {
  assert.ok(!sheet.includes("deriveBadge"), "no badge re-derivation");
  assert.ok(!sheet.includes("badgeFromFlags"), "no badge re-derivation (flags path)");
  assert.ok(!sheet.includes("describeProvenance"), "no provenance re-synthesis");
  assert.ok(!/fleet\s*!=\s*null/.test(sheet), "no structure sniffing (fleet block)");
  assert.ok(!/\.some\(\(?a\)?\s*=>\s*a\.serving/.test(sheet), "no structure sniffing (serving scan)");
});

test("three buckets render unconditionally with explicit empty states", () => {
  // BucketSection receives testId = `${testIdPrefix}-<bucket>` and always
  // renders an `-empty` state marker chosen by count — sections never skip.
  const emptyMarkers = [...sheet.matchAll(/data-testid=\{`\$\{testId\}-empty`\}/g)].map(() => 1);
  assert.ok(emptyMarkers.length >= 1, "the bucket section carries an empty-state marker");
  const bucketTestIds = [...sheet.matchAll(/testId=\{`\$\{testIdPrefix\}-(\w+)`\}/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(bucketTestIds)].sort(),
    ["mcp", "persona", "skills"],
    "all three buckets are wired through BucketSection",
  );
  // The empty state lives inside BucketSection, chosen by `count === 0` —
  // i.e. the section ALWAYS renders; only its inner content is conditional.
  assert.match(sheet, /count === 0 \?/, "bucket section switches content on count, never skips the section");
  // No caller can render the sheet with a bucket missing: buckets are not props.
  assert.ok(!/showPersona|hidePersona|personaBucket=\{/.test(sheet), "no bucket-visibility props");
});

test("both consumer surfaces consume the SAME component", () => {
  assert.match(dialog, /import \{ AgentSpecSheet \} from "\.\/AgentSpecSheet";/);
  assert.match(dialog, /<AgentSpecSheet\s+variant="full"\s+testIdPrefix="pack"/, "dialog uses full variant, pack prefix");
  assert.match(picker, /import \{ AgentSpecSheet \} from "@\/components\/packs\/AgentSpecSheet";/);
  assert.match(picker, /variant="compact"/, "picker uses the compact variant");
});

test("prefix 'pack' reproduces the legacy e2e anchors", () => {
  // The anchors e2e/packs.spec.js, e2e/onboarding.spec.js rely on, derived
  // from the sheet's own testid scheme with prefix "pack":
  const anchors = [
    ["`${testIdPrefix}-skill-${s.name}`", "pack-skill-<name>"],
    ["`${testIdPrefix}-skill-download-${s.name}`", "pack-skill-download-<name>"],
    ["`${testIdPrefix}-mcp-tool-face-${r.registryName}`", "pack-mcp-tool-face-<registry>"],
    ["`${testIdPrefix}-guide-card`", "pack-guide-card"],
    ["`${testIdPrefix}-agent-serving-${a.id}`", "pack-agent-serving-<id>"],
    ["`${testIdPrefix}-agent-rhythm-default-${a.id}`", "pack-agent-rhythm-default-<id>"],
  ];
  for (const [expr] of anchors) {
    assert.ok(sheet.includes(expr), `sheet emits ${expr}`);
  }
});

test("dialog keeps its legacy guide card (client fallback retires with move-pack-guides-to-manifest)", () => {
  // Interim state, documented in the change: the dialog's own guide card
  // (manifest.guide ?? guideFor) stays until the content migration lands;
  // the sheet itself is passed no guide from the dialog.
  assert.ok(!/guideFor\(packId\)/.test(dialog), "client-module fallback retired (move-pack-guides 3.3 终态) — manifest.guide is the only source");
  const sheetCall = dialog.slice(dialog.indexOf("<AgentSpecSheet"), dialog.indexOf("/>", dialog.indexOf("<AgentSpecSheet")));
  assert.ok(!sheetCall.includes("guide="), "dialog does not pass guide into the sheet");
});

test("i18n: packs.specSheet keys exist in all five locales", () => {
  const locales = ["zh-CN", "en", "ja", "fr", "es"];
  for (const loc of locales) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    const s = d.packs?.specSheet;
    assert.ok(s, `${loc}: packs.specSheet present`);
    for (const k of [
      "emptyPersona",
      "emptySkills",
      "emptyMcp",
      "skillBody",
      "compactPersonaMissing",
      "compactSkills",
      "compactSkillsZero",
      "compactTools",
      "compactToolsZero",
    ]) {
      assert.ok(typeof s[k] === "string" && s[k].length > 0, `${loc}: specSheet.${k} non-empty`);
    }
  }
});

test("sheet reuses existing chrome keys (no duplicate section-title keys)", () => {
  // Section titles come from the packs.detail.* keys the dialog always used —
  // zero new chrome keys for titles, parity rides the existing gate.
  assert.match(sheet, /t\("packs\.detail\.agents"\)/);
  assert.match(sheet, /t\("packs\.detail\.skills"\)/);
  assert.match(sheet, /t\("packs\.detail\.mcp"\)/);
  assert.ok(sheet.includes('"packs.detail.toolFaceDeclared"'), "tool-face strings are the dialog's own keys");
  assert.ok(sheet.includes('"packs.detail.toolFaceFull"'), "tool-face strings are the dialog's own keys");
  assert.ok(sheet.includes('"packs.detail.toolFaceUndeclared"'), "tool-face strings are the dialog's own keys");
});
