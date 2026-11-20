#!/usr/bin/env node
// ── Route-family assembly gate (fix-route-assembly-regression) ──────────────
//
// 事故来源（2026-11-17，`44d551270`）：`server.js` 被整份替换成更旧的一版，
// 8 类路由注册连同它们的 import 一起消失——输入卡、团队卡、降级读面、舰队凭据
// 包、微信客服、runner 双挂载、启动自愈。实现文件都在、导出都在、`scripts/test-*.mjs`
// 全绿（那些测试自己 import 再自己 register），所以没有任何信号；三天后才由一张
// 「读取失败: HTTP 404」的生产截图暴露。
//
// `check-import-integrity.mjs` 看不见这种塌方：它证明的是「import 能解析」，而
// 这次连 import 语句本身也被删了。本闸判的是另一半——**导出之后有没有被挂上**。
//
// 判据：从三个可部署入口（cell / gateway / facet host）出发求相对 import 的可达集，
// 再在**可达集内**找每个路由族符号的调用点。只看入口文件会得到一半的假阳性
// （装配常是两跳：`facet/index.js → studio.js → blueprints.js`），而假阳性会让人
// 关掉闸——所以判据定稿前先跑了原型。
//
// 不挂的合法情形进 `scripts/route-assembly-baseline.json`，每条带 reason + date，
// 且拒绝通配/目录级条目（行内豁免注释会在文件被替换时一起消失，正是这次的失败模式）。
//
// 用法：`node scripts/test-route-assembly.mjs`（或经 `npm run test:unit` 执行）

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The deployable entrypoints. Each is a process this image or repo can actually start.
const ENTRYPOINTS = ["server.js", "gateway/index.js", "facet/index.js"];
const SCAN_DIRS = ["server", "gateway", "facet", "lib"];
const BASELINE = path.join(ROOT, "scripts/route-assembly-baseline.json");

const ROUTE_FAMILY_RE = /export\s+(?:async\s+)?function\s+((?:register|create)\w*Routes)\s*\(/g;
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g;

function resolveSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`,
    path.join(base, "index.js"), path.join(base, "index.mjs")];
  return candidates.find((c) => {
    try { return fs.statSync(c).isFile(); } catch { return false; }
  }) ?? null;
}

/** Every file reachable from the deployable entrypoints by relative imports. */
function reachableFiles() {
  const seen = new Set();
  const queue = ENTRYPOINTS.map((e) => path.join(ROOT, e));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = resolveSpecifier(file, m[1]);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function collectSources(dir, out = []) {
  const abs = path.join(ROOT, dir);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) collectSources(path.relative(ROOT, p), out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/** Every exported route family in the scanned dirs, with the file that declares it. */
function declaredRouteFamilies() {
  const families = new Map();
  for (const file of SCAN_DIRS.flatMap((d) => collectSources(d))) {
    let src;
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const m of src.matchAll(ROUTE_FAMILY_RE)) {
      if (!families.has(m[1])) {
        families.set(m[1], path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
  }
  return families;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return { entries: [] };
  const raw = fs.readFileSync(BASELINE, "utf8");
  try { return JSON.parse(raw); } catch (err) {
    assert.fail(`route-assembly-baseline.json is not valid JSON: ${err.message}`);
  }
}

/** Baseline problems that must be red: missing reason/date, wildcards, unknown symbols. */
function baselineProblems(entries, families) {
  const problems = [];
  for (const e of entries) {
    const label = `${e?.path ?? "?"} -> ${e?.symbol ?? "?"}`;
    if (!e?.symbol || !e?.path) { problems.push(`${label}: needs both \`path\` and \`symbol\``); continue; }
    if (/[*?]/.test(e.symbol) || /\/\*\*|\*/.test(String(e.path))) {
      problems.push(`${label}: wildcard/directory exemptions are not allowed`);
    }
    if (!String(e.reason ?? "").trim()) problems.push(`${label}: missing \`reason\``);
    if (!String(e.date ?? "").trim()) problems.push(`${label}: missing \`date\``);
    if (!families.has(e.symbol)) {
      problems.push(`${label}: symbol no longer exported — drop the exemption`);
    }
  }
  return problems;
}

const reachable = reachableFiles();
// Comments are stripped before looking for call sites: a commented-out mount must
// NOT read as a mount. (First draft matched raw source and a `// registerX(ctx);`
// line kept the gate green — the exact "green for the wrong reason" failure this
// gate exists to prevent.)
/**
 * Line-scanned call detection. A regex over the whole source cannot tell a call
 * from an `import { … }` line, an `export function …` declaration, or a
 * commented-out mount — and stripping comments with a block-comment regex ate
 * 185 lines of `facet/index.js` (a `/*` inside a string literal), which made
 * every mount in that region read as missing. So: one line at a time, and a
 * line only counts when it is not an import, a declaration, or a comment.
 */
function callsSymbol(src, symbol) {
  const call = new RegExp(`(^|[^\\w$.])${symbol}\\s*\\(`);
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(import|export)\b/.test(line)) continue;
    if (/^(\/\/|\*|\/\*)/.test(line)) continue;
    // Trailing `// … registerXRoutes(…)` in a comment after code stays valid —
    // the code before it is what we are matching, so check the pre-comment part.
    const code = line.split("//")[0];
    if (call.test(code)) return true;
  }
  return false;
}

const reachableSource = [...reachable].map((f) => {
  try { return fs.readFileSync(f, "utf8"); } catch { return ""; }
});
const families = declaredRouteFamilies();

/** Route families with no call site anywhere in the production reachable set. */
function unmountedFamilies() {
  const unmounted = [];
  for (const [symbol, file] of families) {
    if (!reachableSource.some((src) => callsSymbol(src, symbol))) {
      unmounted.push({ symbol, file });
    }
  }
  return unmounted;
}

test("every exported route family is mounted somewhere the deployable entrypoints reach", () => {
  const baseline = loadBaseline();
  const exempt = new Set((baseline.entries ?? []).map((e) => e.symbol));
  const missing = unmountedFamilies().filter((f) => !exempt.has(f.symbol));

  assert.deepEqual(
    missing.map((f) => `${f.file} -> ${f.symbol}`),
    [],
    "route families are declared but never mounted from a production entrypoint.\n" +
    "Either mount them, or record a reason+date exemption in scripts/route-assembly-baseline.json.\n" +
    "A green test that registers the module itself is NOT assembly evidence.",
  );
});

test("the gate has real reach — it sees the entrypoints and their transitive imports", () => {
  // A silently-empty reachable set would make the first test pass for the wrong reason
  // (green because nothing was scanned, not because everything is wired).
  for (const entry of ENTRYPOINTS) {
    assert.ok(reachable.has(path.join(ROOT, entry)), `${entry} must be scanned`);
  }
  assert.ok(families.size >= 50, `expected the repo's route families, saw ${families.size}`);
  assert.ok(reachable.size >= 100, `expected a transitive import set, saw ${reachable.size}`);
});

test("baseline exemptions carry a reason and a date, and name live symbols", () => {
  const baseline = loadBaseline();
  assert.deepEqual(baselineProblems(baseline.entries ?? [], families), []);
});
