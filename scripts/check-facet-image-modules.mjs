#!/usr/bin/env node
// ── facet Dockerfile COPY list covers every facet module index.js imports ────
//
//   node scripts/check-facet-image-modules.mjs [--dockerfile <path>]
//
// 2026-11-21 实祸：`facet/plaza-export-schedule.js` 被 index.js import，却没进
// Dockerfile 那条**逐文件列举**的 COPY 行。镜像构建成功、平台 role 的冒烟门也绿
// ——它压根不启 facet role——而 facet 是 Recreate 策略，卷上去就地 0/1 Error：
//   ERR_MODULE_NOT_FOUND: /app/facet/plaza-export-schedule.js
// 生产因此中断数分钟。
//
// Dockerfile 那一行自己在注释里就写着这个坑（「import NOT on this list
// crashloops the facet role only」）——写下来了，但没有东西会检查它。本闸补的就是
// 那一句「没有东西会检查」。
//
// 判据：从 index.js 出发求相对 import 的闭包（facet/ 内 + 它引到的 ../gateway 等
// **不进镜像**的路径要显式列在 EXTERNAL_ALLOW 里），每一个落在 facet/ 下的模块都
// 必须在 Dockerfile 的 facet COPY 行出现。缺一个即红并点名。
//
// 退出码：0 齐全 / 1 有缺 / 2 判不出（Dockerfile 或源文件读不到）。
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Static relative imports of a file (ESM `import ... from "..."`). */
export function relativeImports(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = new Set();
  const re = /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) {
    const spec = m[1];
    if (spec.startsWith(".")) out.add(spec);
  }
  return [...out];
}

/** The set of facet/ modules reachable from entry (facet-relative, posix). */
export function facetModuleClosure(entry, { repo = REPO, seen = new Set() } = {}) {
  const abs = path.resolve(repo, entry);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  let imports;
  try {
    imports = relativeImports(abs);
  } catch {
    return seen;
  }
  for (const spec of imports) {
    const target = path.resolve(path.dirname(abs), spec);
    // Only follow files that live under facet/ — anything else is a dependency
    // shipped by another COPY line (gateway/, lib/, registry-bridge.js).
    const rel = path.relative(path.join(repo, "facet"), target);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      facetModuleClosure(path.relative(repo, target), { repo, seen });
    }
  }
  return seen;
}

/** Modules named on the Dockerfile's facet COPY line. */
export function dockerfileFacetModules(dockerfile) {
  const src = fs.readFileSync(dockerfile, "utf8");
  // The facet COPY line is the one ending in `./facet/`.
  const line = src.split("\n").find((l) => /COPY .*\/app\/facet\/.*\.\/facet\/\s*$/.test(l));
  if (!line) return null;
  return new Set(
    [...line.matchAll(/\/app\/facet\/([A-Za-z0-9_.-]+\.js)/g)].map((m) => m[1]),
  );
}

const missingFrom = (repo = REPO, dockerfile = path.join(repo, "Dockerfile")) => {
  const closure = facetModuleClosure("facet/index.js", { repo });
  const shipped = dockerfileFacetModules(dockerfile);
  if (!shipped) return null;
  const missing = [];
  for (const abs of closure) {
    const name = path.basename(abs);
    if (!shipped.has(name)) missing.push(name);
  }
  return { missing, shipped: shipped.size, closure: closure.size };
};

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const repo = (() => {
    const i = process.argv.indexOf("--repo");
    return i > 0 ? path.resolve(process.argv[i + 1]) : REPO;
  })();
  const dockerfile = (() => {
    const i = process.argv.indexOf("--dockerfile");
    return i > 0 ? path.resolve(process.argv[i + 1]) : path.join(repo, "Dockerfile");
  })();
  if (!fs.existsSync(dockerfile)) {
    console.log(`UNDETERMINED: ${dockerfile} not found`);
    process.exit(2);
  }
  const r = missingFrom(repo, dockerfile);
  if (!r) {
    console.log("UNDETERMINED: no facet COPY line in Dockerfile");
    process.exit(2);
  }
  if (r.missing.length) {
    console.log(`FAIL: ${r.missing.length} module(s) imported by facet/index.js are not in the image:`);
    for (const m of r.missing) console.log(`  - facet/${m}`);
    console.log("  → add them to the Dockerfile facet COPY line, or the facet role crashloops on boot");
    process.exit(1);
  }
  console.log(`OK: all ${r.closure} facet modules reachable from index.js are shipped (${r.shipped} on the COPY line)`);
  process.exit(0);
}

// ── self-tests (fixtures, no repo state) ────────────────────────────────────
test("relativeImports finds only relative specifiers", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "facetchk-"));
  const f = path.join(dir, "a.js");
  fs.writeFileSync(f, 'import x from "./b.js";\nimport y from "node:fs";\nimport {z} from "../gateway/z.js";\n');
  const got = relativeImports(f);
  assert.deepEqual(got.sort(), ["../gateway/z.js", "./b.js"]);
});

test("dockerfileFacetModules parses the facet COPY line", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "facetchk-"));
  const df = path.join(dir, "Dockerfile");
  fs.writeFileSync(df, "COPY --from=builder /app/facet/index.js /app/facet/a.js ./facet/\n");
  const got = dockerfileFacetModules(df);
  assert.deepEqual([...got].sort(), ["a.js", "index.js"]);
});

test("a module missing from the COPY line is reported", () => {
  const repo = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "facetrepo-"));
  fs.mkdirSync(path.join(repo, "facet"));
  fs.writeFileSync(path.join(repo, "facet", "index.js"), 'import "./a.js";\nimport "./forgotten.js";\n');
  fs.writeFileSync(path.join(repo, "facet", "a.js"), "\n");
  fs.writeFileSync(path.join(repo, "facet", "forgotten.js"), "\n");
  fs.writeFileSync(
    path.join(repo, "Dockerfile"),
    "COPY --from=builder /app/facet/index.js /app/facet/a.js ./facet/\n",
  );
  const r = missingFrom(repo, path.join(repo, "Dockerfile"));
  assert.deepEqual(r.missing, ["forgotten.js"]);
});
