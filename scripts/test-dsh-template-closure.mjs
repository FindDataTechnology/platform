#!/usr/bin/env node
// ── dsh-profile-template closure gate (add-tool-description-enrichment) ─────
//
// 出片门（facet 静态门同款判据，管的是另一半运行时）：platform-preset-bridge
// （含 notify 子类）随 patch 拷进每个 profile 目录，它的相对 import 闭包里
// 每一个仓内模板文件，都必须被 dsh-profile.js 的某个拷贝点携带——桥新增一
// 个相对 import 而拷贝点没跟上，就是 ERR_MODULE_NOT_FOUND 的崩溃循环
// （facet 静态门注释里的同一根因，2026-11-01 在 notify 桥测试上真实发生）。
//
// 判据：从运行期可达的桥文件出发走相对 import 传递闭包；闭包内每个模板
// .js 必须以文件名形式出现在 dsh-profile.js 源里（拷贝点都以字面量文件名
// 写 atomicWriteTextSync/copyFileSync）。刻意不处理 cordis/SDK 包 import
// ——它们来自 node_modules，不进模板拷贝纪律。
//
//   node --test scripts/test-dsh-template-closure.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = join(ROOT, "dsh-profile-template");
const ENTRY_FILES = ["platform-preset-bridge.js", "platform-notify-bridge.js", "platform-tool-scope.js", "platform-tool-description.js"];
const REL_IMPORT_RE = /(?:^|[\s;])(?:import|export)[^"'`]*?from\s*["'](\.\.?\/[^"']+\.js)["']/g;
const SIDE_EFFECT_RE = /(?:^|[\s;])import\s*["'](\.\.?\/[^"']+\.js)["']/g;

function relImportsOf(absFile) {
  const src = readFileSync(absFile, "utf8");
  const out = new Set();
  for (const re of [REL_IMPORT_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const target = resolve(dirname(absFile), m[1]);
      // Only the template dir is the closure's jurisdiction; ../lib imports
      // ride the platform process (dsh-profile itself), not the profile copy.
      if (target.startsWith(TEMPLATE_DIR) && target.endsWith(".js")) out.add(target);
    }
  }
  return out;
}

test("runtime-reachable template closure is fully carried by dsh-profile copy sites", () => {
  const dshProfileSrc = readFileSync(join(ROOT, "dsh-profile.js"), "utf8");
  const seen = new Set();
  const missing = [];
  const queue = ENTRY_FILES.map((f) => join(TEMPLATE_DIR, f));
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (!existsSync(cur)) {
      missing.push(cur);
      continue;
    }
    for (const dep of relImportsOf(cur)) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  assert.deepEqual(missing, [], "every reachable template file exists");

  for (const abs of seen) {
    const name = abs.slice(TEMPLATE_DIR.length + 1);
    assert.ok(
      dshProfileSrc.includes(`"${name}"`),
      `dsh-profile.js 没有任何拷贝点携带 dsh-profile-template/${name}（桥 import 闭包内）——补一个 atomicWriteTextSync 拷贝点，否则 profile 目录 ERR_MODULE_NOT_FOUND 崩溃循环`,
    );
  }
});
