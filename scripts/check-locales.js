#!/usr/bin/env node
// check-locales: enforce translation-resource parity.
//
// Loads every web/src/locales/<locale>/common.json and asserts:
//   1. each non-English locale exposes exactly the same key set as `en`
//      (no missing keys, no extra/stale keys);
//   2. no value is empty.
//
// Exits non-zero on any drift so a mis-translated or half-translated bundle
// fails the build (wired into `web:build`). English is the source of truth.
//
// Run: `npm run check:locales` (root) or `node scripts/check-locales.js`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = path.join(root, "web", "src", "locales");

const SOURCE = "en";

/** Collect every leaf key path (dotted) from a nested object. */
function collectKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...collectKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function loadLocale(locale) {
  const file = path.join(localesDir, locale, "common.json");
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

if (!fs.existsSync(localesDir)) {
  console.error(`[check-locales] locales dir not found: ${localesDir}`);
  process.exit(1);
}

const locales = fs
  .readdirSync(localesDir)
  .filter((d) => fs.statSync(path.join(localesDir, d)).isDirectory());

if (!locales.includes(SOURCE)) {
  console.error(`[check-locales] source locale '${SOURCE}' missing from ${localesDir}`);
  process.exit(1);
}

const sourceKeys = new Set(collectKeys(loadLocale(SOURCE)));
let errors = 0;

for (const locale of locales) {
  if (locale === SOURCE) {
    // Still assert no empty values in the source.
    const data = loadLocale(locale);
    for (const key of collectKeys(data)) {
      const parts = key.split(".");
      let val = data;
      for (const p of parts) val = val?.[p];
      if (val === "" || val == null) {
        console.error(`[check-locales] ${SOURCE}: empty value at '${key}'`);
        errors++;
      }
    }
    continue;
  }

  const data = loadLocale(locale);
  const keys = new Set(collectKeys(data));

  const missing = [...sourceKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !sourceKeys.has(k));
  const empty = [...keys].filter((k) => {
    const parts = k.split(".");
    let val = data;
    for (const p of parts) val = val?.[p];
    return val === "" || val == null;
  });

  if (missing.length || extra.length || empty.length) {
    errors++;
    console.error(`[check-locales] ${locale}: drift from '${SOURCE}'`);
    for (const k of missing) console.error(`  - missing: ${k}`);
    for (const k of extra) console.error(`  - extra:   ${k}`);
    for (const k of empty) console.error(`  - empty:   ${k}`);
  } else {
    console.log(`[check-locales] ${locale}: OK (${keys.size} keys)`);
  }
}

if (errors) {
  console.error(`\n[check-locales] ${errors} locale(s) with drift. Fix the above.`);
  process.exit(1);
}
console.log(`[check-locales] all ${locales.length} locales OK.`);
