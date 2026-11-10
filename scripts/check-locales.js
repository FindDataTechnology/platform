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

// ── 代码侧键存在性（2026-10-29 增补） ─────────────────────────────────────
//
// 上面的比对只证「各语言之间一致」——**一致地缺失**照样全绿。真实事故：
// BlueprintStudioPage 用的是 `blueprints.judge.model.*`，而资源里那批键躺在
// `blueprints.model.*` 下（无人引用的孤儿块），于是评审模型下拉的标签与提示
// 全渲染成原始键名，而 locale 门五语「OK (2456 keys)」照过。
//
// 分级处置：
//   · 本清单覆盖的界面（ENFORCED_PREFIXES）——缺键即失败，因为那是我改的，
//     必须当场补齐；
//   · 其余界面——只列报告警，不判红。它们属并行会话在途的车道，替人补文案
//     会与其改动抢同一份资源文件（仓律：别 -A、别扫走别人的改动）。
const webSrc = path.join(root, "web", "src");
const LITERAL_T_RE = /\bt\(\s*["'`]([A-Za-z0-9_$][A-Za-z0-9_$.\-]*)["'`]/g;
const KEY_ALLOWLIST = new Set();
// 本 change（蓝图构造间）负责的界面键前缀。
const ENFORCED_PREFIXES = ["blueprints."];

// i18next 把 `t("x.y", { count })` 解析成 `x.y_one` / `x.y_other`（以及
// `_zero`/`_two`/`_few`/`_many`）。代码写的是不带后缀的基名，资源里只有带后缀
// 的复数形式——只按字面查会把真存在的键报成缺失（首版就这样误报了
// `fleet.live.summary`）。任一带复数后缀的形式在场即视为已解析。
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];
const hasKey = (base) => sourceKeys.has(base) || PLURAL_SUFFIXES.some((s) => sourceKeys.has(base + s));

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

const unknownKeys = new Map(); // key → Set(files)
if (fs.existsSync(webSrc)) {
  for (const file of walk(webSrc)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(LITERAL_T_RE)) {
      const key = m[1];
      // 只审「像资源键」的字面量（含点）；纯单词多为变量名或非 i18n 调用。
      if (!key.includes(".")) continue;
      if (KEY_ALLOWLIST.has(key)) continue;
      if (hasKey(key)) continue;
      if (!unknownKeys.has(key)) unknownKeys.set(key, new Set());
      unknownKeys.get(key).add(path.relative(root, file));
    }
  }
}

const enforced = [...unknownKeys.entries()].filter(([k]) => ENFORCED_PREFIXES.some((p) => k.startsWith(p)));
const others = [...unknownKeys.entries()].filter(([k]) => !ENFORCED_PREFIXES.some((p) => k.startsWith(p)));

if (others.length) {
  console.warn(`\n[check-locales] warning: ${others.length} key(s) referenced in code but absent from '${SOURCE}' (outside this change's scope — not failing):`);
  for (const [key, files] of others) console.warn(`  - ${key}  ← ${[...files].join(", ")}`);
}

if (enforced.length) {
  console.error(`\n[check-locales] ${enforced.length} key(s) referenced in code but absent from '${SOURCE}':`);
  for (const [key, files] of enforced) console.error(`  - ${key}  ← ${[...files].join(", ")}`);
  console.error("\nThese would render as raw key strings at runtime.");
  process.exit(1);
}
console.log(`[check-locales] code-side key references OK (${ENFORCED_PREFIXES.join(", ")}).`);

console.log(`[check-locales] all ${locales.length} locales OK.`);
