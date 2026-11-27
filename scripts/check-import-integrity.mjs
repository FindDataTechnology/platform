#!/usr/bin/env node
// check-import-integrity: 静态扫描本仓后端模块的相对 import 断链。
//
// 事故来源（2026-10-28，台账 §15.69）：`gateway/zhiyu/index.js` 已提交对
// `./im-bridge.js` 的 import，而该模块长期停在**工作树未跟踪态**——快照镜像只含
// tracked 文件，于是任何从 main 出的镜像**启动即崩**（ERR_MODULE_NOT_FOUND），
// 生产 502 约 10 分钟。同因在 `server.js → server/zhiyu-im-bridge.js` 上重演一次。
//
// 本脚本把这条件变成一条可跑的门：仓库内后端目录的每个 `.js/.mjs`，其相对 import
// （含 `import()` 动态形式）必须能解析到**磁盘上存在**的文件（含 .js/.mjs/index.js）。
// 只做静态解析，不执行任何模块——适合放进 CI 或出片前的启动门。
//
// 用法：`node scripts/check-import-integrity.mjs [--root <dir>]`
//   · 默认扫描 server/ gateway/ lib/ packages/core/src 与根目录的 server.js
//   · 退出码 0 = 全部可解析；1 = 存在断链（逐条打印 文件 → 说明符）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argRoot = process.argv.indexOf("--root");
const ROOT = path.resolve(argRoot > -1 ? process.argv[argRoot + 1] : path.join(here, ".."));
const SCAN_DIRS = ["server", "gateway", "lib", "packages/core/src"];
const SCAN_FILES = ["server.js"];

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g;

function collect(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
}

function resolves(base) {
  return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`,
    path.join(base, "index.js"), path.join(base, "index.mjs")].some((c) => fs.existsSync(c));
}

const files = [];
for (const d of SCAN_DIRS) collect(path.join(ROOT, d), files);
for (const f of SCAN_FILES) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
}

const broken = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!resolves(path.resolve(path.dirname(file), spec))) {
      broken.push({ file: path.relative(ROOT, file), spec });
    }
  }
}

if (broken.length === 0) {
  console.log(`[check-import-integrity] OK — ${files.length} 个后端模块，相对 import 全部可解析`);
  process.exit(0);
}

console.error(`[check-import-integrity] 发现 ${broken.length} 处断链（快照镜像会启动即崩）：`);
for (const b of broken) console.error(`  ${b.file} → ${b.spec}`);
console.error("修法：把被引模块 `git add` 入库，或移除该 import（勿在未跟踪态留下 import 侧）。");
process.exit(1);