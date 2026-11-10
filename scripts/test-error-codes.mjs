#!/usr/bin/env node
// ── Stable error-code map tests (add-agent-builder-workspace 5.1/5.2) ──────
//
// Pins the client-side half of the code discipline by source assertion (the
// .mjs cannot import TS at runtime):
//   1. every code in CODE_SUMMARY_KEYS resolves to a studio.errors.<code>
//      key present in all five locales (5.2: 每条 code 恰一摘要键、五语齐全)
//   2. the ValidationPanel consumes the map (codeSummaryKey) and anchors
//      envelope errors by code (name_too_long → boundary.name, …)
//   3. unknown codes are not mapped — the no-guessing discipline is structural
//      (codeSummaryKey returns null; the table simply has no entry)
//
//   node --test scripts/test-error-codes.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("every mapped code resolves to a studio.errors key in all five locales", () => {
  const src = read("web/src/lib/error-codes.ts");
  const entries = [...src.matchAll(/([a-z_]+):\s*"studio\.errors\.[a-z_]+"/g)].map((m) => m[1]);
  assert.ok(entries.length >= 40, `expected the full explicit-code map, found ${entries.length}`);
  const seen = new Set(entries);
  assert.equal(seen.size, entries.length, "no duplicate code keys");
  for (const loc of ["zh-CN", "en", "ja", "fr", "es"]) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    const errors = d.studio?.errors;
    assert.ok(errors, `${loc}: studio.errors block present`);
    for (const code of entries) {
      const match = src.match(new RegExp(`${code}:\\s*"studio\\.(errors\\.[a-z_]+)"`));
      assert.ok(match, `${code}: its summary key is findable`);
      const key = match[1].split(".").slice(1).join(".");
      assert.ok(typeof errors[key] === "string" && errors[key].length > 0, `${loc}: studio.errors.${key} for code ${code}`);
    }
  }
});

test("unknown codes are never mapped (the no-guessing discipline is structural)", () => {
  // The map's keys ARE the universe: codeSummaryKey looks up CODE_SUMMARY_KEYS
  // and returns null for anything absent — there is no substring/guess path.
  const src = read("web/src/lib/error-codes.ts");
  assert.match(src, /return CODE_SUMMARY_KEYS\[code\] \?\? null/, "lookup returns null on miss");
  // No derived-code fallback (e.g. kebab-case the error text) may exist.
  assert.ok(!/toLowerCase|match\(\/\[a-z0-9/.test(src), "no text-derived guessing in the client map");
});

test("ValidationPanel: consumes the map and anchors envelope errors by code", () => {
  const src = read("web/src/components/studio/ValidationPanel.tsx");
  assert.match(src, /import \{ codeSummaryKey \} from "@\/lib\/error-codes"/, "the panel imports the map");
  assert.match(src, /codeSummaryKey\(e\.code\)/, "the panel consults the map per finding");
  assert.match(src, /CODE_ANCHORS[\s\S]*name_too_long: "boundary\.name"/, "name_too_long anchors the header name field");
  assert.match(src, /description_too_long: "boundary\.oneLine"/, "description_too_long anchors the one-line field");
  assert.match(src, /anchorForError\(e\.entry, e\.error, e\.code\)/, "the entry path stays primary; code is the fallback");
});
