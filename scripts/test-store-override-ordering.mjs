// ── A store override must be set BEFORE the module that binds it is evaluated ─
//
// The hazard is ESM import hoisting. `task-engine.js` and its five siblings read
// their on-disk location from an env var at MODULE EVALUATION:
//
//     const TASK_STORAGE_DIR = storeDir("cron-store", process.env.CRON_STORAGE_PATH);
//
// so a test that writes
//
//     import * as engine from "../task-engine.js";   // ← evaluated here
//     process.env.CRON_STORAGE_PATH = tmpRoot;       // ← always one step late
//
// gets no throwaway store at all: the store resolves to the CWD default, which
// inside this repo is the gitignored `cron-store/jobs.json` (or `data/`). Three
// consequences, each with its own blindfold — measured 2026-11-15:
//
//   1. the file is gitignored, so `git status` stays clean and nobody sees it;
//   2. every test file shares that one store, so an assertion can pass because of
//      state another file left behind — the only visible fingerprint is the
//      engine logging a *growing* "Loaded N task(s) from storage";
//   3. the correct shape already existed in a sibling file, explained in a
//      comment — and a comment is not a check, so the others drifted.
//
// The import that matters is not only the DIRECT one. A test that statically
// imports any repo module reaches whatever that module statically imports, so
// `import { x } from "../server/context.js"` binds `db.js` and `paths.js` just
// as surely as importing them by name. That instance was real (2026-11-15,
// scripts/test-connector-credentials.mjs: DB_PATH/PLATFORM_DATA_DIR were set
// after a static `../server/context.js` import, and the run wrote
// `data/mcp-preflight.json` into the working tree). Hence the check below walks
// the static-import GRAPH rather than the file's own import list.
//
// This file is written as a unit test so it rides the lane and the CI shards
// without wiring. Its analysis is deliberately textual (no module loading):
// importing a module to observe where it wrote would itself be the side effect
// we are preventing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unitFiles } from "./unit-shard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Env var → the module that resolves it at evaluation time.
 *
 * Adding a row is only legitimate after reading the module and confirming the
 * bind is at module scope rather than inside a function; `at` records that
 * reading so the next person does not redo it.
 */
const ENV_BINDERS = [
  { env: "CRON_STORAGE_PATH", module: "task-engine.js", at: "task-engine.js:20 — `const TASK_STORAGE_DIR = storeDir(...)`" },
  { env: "DB_PATH", module: "db.js", at: "db.js:20 — `const DEFAULT_DB_PATH = process.env.DB_PATH ? … : …`" },
  { env: "SESSIONS_STORE_DIR", module: "chat-history.js", at: "chat-history.js:32 — `let SESSIONS_DIR = storeDir(...)`" },
  { env: "LLM_PROVIDERS_STORE", module: "llm-providers.js", at: "llm-providers.js:41 — `const STORE_PATH = storeDir(...)`" },
  { env: "LLM_DEFAULT_STORE", module: "llm-providers.js", at: "llm-providers.js:42 — `const DEFAULT_PATH = storeDir(...)`" },
  { env: "MCP_PREFLIGHT_FILE", module: "mcp-preflight.js", at: "mcp-preflight.js:31 — `const STATE_FILE = process.env.MCP_PREFLIGHT_FILE || …`" },
  { env: "PLATFORM_DATA_DIR", module: "paths.js", at: 'paths.js:17 — `export const PLATFORM_DATA_DIR = process.env.PLATFORM_DATA_DIR || ""`' },
];

const BINDER_MODULES = [...new Set(ENV_BINDERS.map((r) => r.module))];

// Directories that cannot hold a module a unit test reaches. `web`/`miniapp`/
// `app` have their own toolchains; the rest are build output or docs.
const GRAPH_SKIP = new Set([
  "node_modules", ".git", "web", "miniapp", "app", "docs", "dist", "build",
  "graphify-out", "e2e", "coverage",
]);

/** Static `import … from "mod"` spans (multi-line aware); dynamic `import()` is not static. */
function staticImportsOf(source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*import\s/.test(line)) continue;
    if (/^\s*import\s*\(/.test(line)) continue; // dynamic import — the correct shape
    const start = i + 1;
    let text = line;
    // A statement ends when it carries `from "x"`, or is a bare `import "x"`.
    while (!/from\s*["'][^"']+["']/.test(text) && !/^\s*import\s*["'][^"']+["']/.test(text)) {
      i += 1;
      if (i >= lines.length) break;
      text += "\n" + lines[i];
    }
    const m = text.match(/from\s*["']([^"']+)["']/) || text.match(/^\s*import\s*["']([^"']+)["']/);
    if (m) out.push({ spec: m[1], module: path.basename(m[1]), line: start });
  }
  return out;
}

/** `process.env.X = …` assignments with their 1-based line. */
function envAssignments(source) {
  const out = [];
  source.split("\n").forEach((line, i) => {
    const m = line.match(/process\.env\.([A-Z_][A-Z_0-9]*)\s*=/);
    if (m) out.push({ env: m[1], line: i + 1 });
  });
  return out;
}

function walkModules(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || GRAPH_SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkModules(abs, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(abs);
  }
  return out;
}

/** abs file → its relative static imports (spec + line). Only `./`-style specs are resolved. */
function buildGraph(repo) {
  const graph = new Map();
  for (const abs of walkModules(repo)) {
    const src = fs.readFileSync(abs, "utf8");
    graph.set(abs, staticImportsOf(src).filter((i) => i.spec.startsWith(".")));
  }
  return graph;
}

function resolveSpec(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js"), path.join(base, "index.mjs")]) {
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/**
 * For every module in the graph: the set of binder modules it reaches through
 * STATIC edges (itself included when it IS a binder). Computed as a fixpoint so
 * cycles cannot hide a binder behind an in-progress marker.
 */
function reachability(graph) {
  const reach = new Map();
  const binderBasenames = new Set(BINDER_MODULES);
  for (const abs of graph.keys()) reach.set(abs, new Set());
  for (const [abs] of graph) if (binderBasenames.has(path.basename(abs))) reach.get(abs).add(path.basename(abs));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [abs, imports] of graph) {
      const set = reach.get(abs);
      for (const imp of imports) {
        const target = resolveSpec(abs, imp.spec);
        if (!target) continue;
        for (const b of reach.get(target) ?? []) {
          if (!set.has(b)) {
            set.add(b);
            changed = true;
          }
        }
      }
    }
  }
  return reach;
}

/**
 * The earliest line at which each binder becomes evaluated, given how to ask
 * "which binders does this spec bring in?".
 *
 * @param source  file text
 * @param reachOf spec → Set<binder basenames> reachable through that spec
 */
function evaluatedAt(source, reachOf) {
  const earliest = new Map(); // binder basename → { line, spec }
  for (const imp of staticImportsOf(source)) {
    for (const b of reachOf(imp.spec)) {
      const prev = earliest.get(b);
      if (!prev || imp.line < prev.line) earliest.set(b, { line: imp.line, spec: imp.spec });
    }
  }
  return earliest;
}

/** (env, binder) pairs whose override is assigned AFTER the binder was evaluated. */
function violationsIn(source, reachOf) {
  const earliest = evaluatedAt(source, reachOf);
  if (earliest.size === 0) return [];
  const hits = [];
  for (const a of envAssignments(source)) {
    for (const row of ENV_BINDERS) {
      if (row.env !== a.env) continue;
      const at = earliest.get(row.module);
      if (!at) continue;
      if (a.line > at.line) hits.push({ ...row, importLine: at.line, via: at.spec, assignLine: a.line });
    }
  }
  return hits;
}

// ── the lane ────────────────────────────────────────────────────────────────

test("no unit file overrides a store after the module that binds it was evaluated", () => {
  const files = unitFiles(REPO);
  // A scan that enumerated nothing would "pass" while proving nothing.
  assert.ok(files.length > 100, `枚举到的单测文件只剩 ${files.length} 个——扫错树不能读成「没有缺陷」`);

  const graph = buildGraph(REPO);
  assert.ok(graph.size > 100, `静态导入图只收到 ${graph.size} 个模块——图不完整时「没命中」不算证据`);
  const reach = reachability(graph);

  const problems = [];
  let withOverrides = 0;
  for (const rel of files) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, "utf8");
    if (envAssignments(source).length === 0) continue; // this file wants no override
    withOverrides += 1;
    const reachOf = (spec) => {
      const target = resolveSpec(abs, spec);
      return target ? (reach.get(target) ?? new Set()) : new Set();
    };
    for (const h of violationsIn(source, reachOf)) {
      problems.push(
        `${rel}: ${h.env} 在第 ${h.assignLine} 行赋值，但 "${h.module}" 早在第 ${h.importLine} 行就经 ` +
          `"${h.via}"（静态导入链）求值了\n` +
          `  绑定点：${h.at}\n` +
          `  修法：把那个静态 import 改成赋值之后的 \`const x = await import("…")\`——` +
          `静态 import 会被提升，赋值永远慢一步`,
      );
    }
  }
  // Guard the denominator too: "zero violations" over zero files that set an
  // override would be vacuous.
  assert.ok(withOverrides > 0, "车道里一个设 store 覆盖的文件都没扫到——分母为 0 不能读成干净");
  assert.deepEqual(problems, [], `store 覆盖晚于绑定模块求值：\n${problems.join("\n")}`);
});

// ── the detector must be able to go red, or it is indistinguishable from absent ──

/** Fixture helper: a fake reachability table keyed by the spec string as written. */
const fakeReach = (table) => (spec) => new Set(table[spec] ?? []);

test("the detector reds on the direct defect shape (static import, then override)", () => {
  const hits = violationsIn(
    ['import * as engine from "../task-engine.js";', 'process.env.CRON_STORAGE_PATH = "/tmp/throwaway";'].join("\n"),
    fakeReach({ "../task-engine.js": ["task-engine.js"] }),
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].importLine, 1);
  assert.equal(hits[0].assignLine, 2);
});

test("the detector reds on a multi-line static import too", () => {
  const hits = violationsIn(
    ["import {", "  a,", "  b,", '} from "../task-engine.js";', 'process.env.CRON_STORAGE_PATH = "/tmp/x";'].join("\n"),
    fakeReach({ "../task-engine.js": ["task-engine.js"] }),
  );
  assert.equal(hits.length, 1);
});

test("the detector reds on a TRANSITIVE static import — the case a direct-only check misses", () => {
  const source = [
    'import { attachTurnStateModule } from "../server/context.js";',
    'process.env.DB_PATH = "/tmp/x/platform.db";',
    'process.env.PLATFORM_DATA_DIR = "/tmp/x";',
  ].join("\n");
  const transitive = violationsIn(source, fakeReach({ "../server/context.js": ["db.js", "paths.js"] }));
  assert.equal(transitive.length, 2, "DB_PATH 与 PLATFORM_DATA_DIR 两条都该命中");

  // Same source, but asked the direct-only question the first version of this
  // gate asked: "../server/context.js" is not itself a binder, so nothing reds.
  const directOnly = violationsIn(source, fakeReach({ "../server/context.js": ["context.js"] }));
  assert.deepEqual(directOnly, [], "只认直接导入时这条真实缺陷是绿的——这正是它当初漏掉的原因");
});

test("the correct shape — assign, then dynamic import — is not flagged", () => {
  const hits = violationsIn(
    ['process.env.CRON_STORAGE_PATH = "/tmp/throwaway";', 'const engine = await import("../task-engine.js");'].join("\n"),
    fakeReach({ "../task-engine.js": ["task-engine.js"] }),
  );
  assert.deepEqual(hits, []);
});

test("a file that never overrides the env is not flagged", () => {
  assert.deepEqual(
    violationsIn('import * as engine from "../task-engine.js";', fakeReach({ "../task-engine.js": ["task-engine.js"] })),
    [],
  );
});

test("importing a module that reaches no binder before the override is not flagged", () => {
  const hits = violationsIn(
    ['import { x } from "../plain.js";', 'process.env.CRON_STORAGE_PATH = "/tmp/x";'].join("\n"),
    fakeReach({ "../plain.js": [] }),
  );
  assert.deepEqual(hits, []);
});

test("the same defect on another binder (DB_PATH → db.js) is caught", () => {
  const hits = violationsIn(
    ['import db from "../db.js";', 'process.env.DB_PATH = "/tmp/x/app.db";'].join("\n"),
    fakeReach({ "../db.js": ["db.js", "paths.js"] }),
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].module, "db.js");
});

test("the real graph resolves the binder through the module chain (self-check on this repo)", () => {
  // Pins the graph builder itself: if import resolution silently stopped
  // working, every reach set would be empty and the lane test above would go
  // green for the wrong reason.
  const graph = buildGraph(REPO);
  const reach = reachability(graph);
  const contextAbs = path.join(REPO, "server/context.js");
  assert.ok(fs.existsSync(contextAbs), "server/context.js 不见了——这条自检需要换一个已知的传递入口");
  const viaContext = reach.get(contextAbs) ?? new Set();
  assert.ok(viaContext.has("db.js"), "server/context.js 应当经静态导入链到达 db.js");
  assert.ok(viaContext.has("paths.js"), "server/context.js 应当经静态导入链到达 paths.js");
  // And a leaf module must not invent binders it does not import.
  const pathsAbs = path.join(REPO, "paths.js");
  assert.deepEqual([...(reach.get(pathsAbs) ?? [])].sort(), ["paths.js"]);
});
