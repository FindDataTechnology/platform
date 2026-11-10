#!/usr/bin/env node
// ── design-lint: the color-discipline ratchet gate (web-design-system) ───────
//
// Six rules, scanned over web/src/pages/** and web/src/components/** with the
// shared ui/ primitives directory EXEMPT (primitives own the one place literal
// values may live):
//   hex-color          #rgb/#rrggbb literals outside a tailwind arbitrary value
//   raw-rgba           rgba( written inline instead of a token
//   tw-arbitrary-color bg-[#..] / text-[oklch(..)] literal-color arbitrary
//                      values; -[var(...)] and color-mix(in .., var(..)) are
//                      exempt (they reference the theme)
//   named-color        Tailwind NAMED palette shades (bg-emerald-500, text-amber-600,
//                      bg-blue-400 …) — the "rainbow" tell: a state color invented
//                      locally instead of the status vocabulary. Theme tokens carry
//                      no numeric shade, so family+shade is an unambiguous signal.
//   side-tab-border    border-l-2..9 / border-[lr]-[Npx] (>=2px) — the
//                      "AI UI" side-tab tell; 1px hairline allowed
//   native-confirm     window.confirm( and bare confirm( — batch ③ migrates
//                      these to the themed ConfirmDialog
//
// Ratchet semantics (scripts/design-lint-baseline.json):
//   baseline maps "<file>" -> { "<rule>": allowedCount }.
//   A scan FAILS when a file+rule count EXCEEDS the baseline (or appears in a
//   file with no baseline entry). Counts BELOW baseline are fine — the gate
//   prints a "tighten" hint. This is the same posture as the xingyan
//   ai_readable_check ratchet: block new debt, reward paying old debt down.
//
// Usage:
//   node scripts/design-lint.mjs                 full tree vs baseline
//   node scripts/design-lint.mjs --changed       only git-diff files (HEAD+staged+untracked)
//   node scripts/design-lint.mjs --json          machine output
//   node scripts/design-lint.mjs --update-baseline  rewrite baseline from current scan
//   node scripts/design-lint.mjs --fixture <dir> [file...]  scan a fixture dir (tests)
//
// Exits 1 on new debt, 0 otherwise.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BASELINE_PATH = path.join(here, "design-lint-baseline.json");

export const RULES = [
  "hex-color",
  "raw-rgba",
  "tw-arbitrary-color",
  "named-color",
  "side-tab-border",
  "native-confirm",
  // openspec: web-design-system — micro-labels are script-aware. A label that
  // hardcodes its own tiny size (or re-adds uppercase/tracking on the label
  // roles) defeats the one semantic class and reads broken in Chinese: 10-11px
  // Han strokes mush together and positive tracking pulls the characters apart.
  "hardcoded-micro-label",
];

// Tailwind named palette families + a numeric shade (theme tokens never take a
// numeric shade, so this cannot collide with bg-primary / text-muted-foreground).
const NAMED_COLOR =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|divide|caret|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

// Tailwind color-prop arbitrary values with a literal color payload.
const ARB_COLOR =
  /(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|caret|decoration|accent)-\[[^\]]+\]/g;
const isLiteralArbColor = (m) => {
  const inner = m.slice(m.indexOf("[") + 1, -1).trim();
  if (inner.startsWith("var(") || inner.startsWith("color-mix(")) {
    // color-mix may still smuggle a literal inside — inspect its arguments.
    return /(?:#[0-9a-fA-F]{3,8}|\boklch\(|\bhsla?\(|\brgba?\()/.test(inner);
  }
  return /^(?:#[0-9a-fA-F]{3,8}|oklch\(|hsla?\(|rgba?\()/.test(inner);
};

/**
 * Scan one file's source text. Returns { rule: count }. Pure: usable from
 * tests without touching disk.
 */
export function scanText(text) {
  const counts = {};
  const bump = (rule, n) => {
    if (n) counts[rule] = (counts[rule] || 0) + n;
  };

  // tw-arbitrary-color first; its matched spans are removed from the text the
  // hex-color rule sees, so `bg-[#fff]` counts as arbitrary-value (not twice).
  const arb = (text.match(ARB_COLOR) || []).filter(isLiteralArbColor);
  bump("tw-arbitrary-color", arb.length);
  let stripped = text;
  for (const m of arb) stripped = stripped.replace(m, "·");

  bump("hex-color", (stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length);
  bump("raw-rgba", (stripped.match(/\brgba?\(/g) || []).length);
  bump("named-color", (stripped.match(NAMED_COLOR) || []).length);
  bump("side-tab-border", (stripped.match(/\bborder-[lr]-(?:[2-9]\b|\[([2-9]\d*)px\])/g) || []).length);
  bump(
    "native-confirm",
    (stripped.match(/window\.confirm\(|(?<![A-Za-z0-9_$.])confirm\(/g) || []).length
  );
  // A label role that sets its own micro size instead of using `.micro-label`.
  // Matched only when the same className also carries the old label idiom
  // (uppercase or tracking-wide), so ordinary 10-11px body micro-copy (badges,
  // chip numerals) is not caught — the rule targets the label roles.
  bump(
    "hardcoded-micro-label",
    (stripped.match(/className=(?:"[^"]*\btext-\[(?:10|11)px\][^"]*"|\{"[^"]*\btext-\[(?:10|11)px\][^"]*")/g) || [])
      .filter((m) => /uppercase|tracking-wide/.test(m)).length,
  );
  return counts;
}

/** Is a path scanned at all? pages/** and components/** yes; components/ui/**
 *  and everything else no. Works with repo-relative forward-slash paths. */
export function shouldScan(rel) {
  if (!/\.(tsx|jsx)$/.test(rel)) return false;
  const inUi = rel.includes("/components/ui/");
  if (inUi) return false;
  return rel.includes("/pages/") || rel.includes("/components/");
}

/** Recursively collect scanned files under a directory (forward-slash paths
 *  relative to that dir's parent root). */
export function collectFiles(dir, rootDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, rootDir));
    else {
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      if (shouldScan(rel)) out.push({ rel, full });
    }
  }
  return out;
}

/** Full scan of the tree. Returns Map rel -> counts. */
export function scanTree(webSrcDir) {
  const srcRoot = path.resolve(webSrcDir);
  const projectRoot = path.resolve(srcRoot, "..", "..");
  const results = new Map();
  for (const dir of ["pages", "components"]) {
    const d = path.join(srcRoot, dir);
    if (!fs.existsSync(d)) continue;
    for (const { rel, full } of collectFiles(d, projectRoot)) {
      const c = scanText(fs.readFileSync(full, "utf8"));
      if (Object.keys(c).length) results.set(rel, c);
    }
  }
  return results;
}

/** Ratchet comparison. scan: Map|Object rel->counts; baseline: plain object.
 *  Returns { newViolations: [{file, rule, found, allowed}], tightened: [...] }. */
export function compareRatchet(scan, baseline) {
  const newViolations = [];
  const tightened = [];
  for (const [file, counts] of entriesOf(scan)) {
    const base = baseline[file] || {};
    for (const rule of RULES) {
      const found = counts[rule] || 0;
      const allowed = base[rule] || 0;
      if (found > allowed) newViolations.push({ file, rule, found, allowed });
      else if (found < allowed && allowed > 0 && base[rule] != null) tightened.push({ file, rule, found, allowed });
    }
  }
  return { newViolations, tightened };
}

const entriesOf = (s) => (s instanceof Map ? s.entries() : Object.entries(s).map(([k, v]) => [k, v]));

function gitChangedFiles() {
  const out = execFileSync("git", ["-C", root, "diff", "--name-only", "HEAD"], { encoding: "utf8" });
  const staged = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" });
  const untracked = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
  return new Set([...out.split("\n"), ...staged.split("\n"), ...untracked.split("\n")].filter(Boolean));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Exact-name entrypoint guard: `test-design-lint.mjs` IMPORTS this module from
// node --test, and a loose endsWith() check would run (and exit) the CLI mid-import.
import process from "node:process";
if (path.basename(process.argv[1] || "") === "design-lint.mjs") {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const update = args.includes("--update-baseline");
  const changed = args.includes("--changed");
  const fixtureIdx = args.indexOf("--fixture");

  let scan;
  if (fixtureIdx >= 0) {
    const dir = args[fixtureIdx + 1];
    const files = args.slice(fixtureIdx + 2).filter((a) => !a.startsWith("--"));
    scan = new Map();
    for (const f of files.length ? files : []) {
      scan.set(path.basename(f), scanText(fs.readFileSync(path.join(dir, f), "utf8")));
    }
  } else {
    scan = scanTree(path.join(root, "web", "src"));
  }

  if (update) {
    const obj = {};
    for (const [f, c] of scan) obj[f] = c;
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(obj, null, 2) + "\n");
    console.log(`baseline written: ${obj ? Object.keys(obj).length : 0} files with findings`);
    process.exit(0);
  }

  const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) : {};
  let scanToCompare = scan;
  if (changed && fixtureIdx < 0) {
    const set = gitChangedFiles();
    scanToCompare = new Map([...scan].filter(([rel]) => set.has(rel)));
  }
  const { newViolations, tightened } = compareRatchet(scanToCompare, baseline);

  if (asJson) {
    console.log(JSON.stringify({ newViolations, tightened }, null, 1));
  } else if (newViolations.length) {
    console.error(`design-lint: ${newViolations.length} NEW violation(s) over baseline:`);
    for (const v of newViolations) {
      console.error(`  ${v.file}: ${v.rule} found ${v.found}, allowed ${v.allowed}`);
    }
  } else {
    console.log("design-lint: no new violations.");
    if (tightened.length) {
      console.log(`  hint: ${tightened.length} rule(s) below baseline — run --update-baseline to lock in the progress`);
    }
  }
  process.exit(newViolations.length ? 1 : 0);
}
