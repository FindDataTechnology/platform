// 出片门：facet 运行期文件必须全在 Dockerfile 的 facet COPY 白名单里。
//
// 为什么需要这道门（同一根因已发生两次）：
//   310dd63f  facet/publish-gate.js 新增后未入 COPY 清单 → 三面上线后 facet 角色
//             CrashLoopBackOff（ERR_MODULE_NOT_FOUND），platform/demo 正常。
//   2026-10-31 facet/mcp-registry-json.js 同款（add-marketplace-projection-fanout
//             带了新文件和新 import，漏改同一行白名单）→ facet 再次崩溃循环。
//
// 为什么既有门抓不到：platform 角色的 smoke 只跑默认 CMD（server.js），
// facet 是同一镜像的第二个角色，它缺文件时 platform 侧一切正常。
//
// 判据：从 facet/index.js 出发做相对 import 的传递闭包。凡被 index.js 直接或
// 间接 import 的本地 .js，必须出现在 Dockerfile facet COPY 行里。反过来，
// 清单里列了不存在的文件同样判红（防手改笔误）。
//
// 刻意不处理的：facet/cli/（npm 包 @finddata/facet，不进运行期）与
// facet/marketplace-repo.js（离线导出器，不进运行期）。它们不被 index.js
// 可达，纯可达性闭包天然把它们排除——比维护豁免表更稳。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "facet/index.js";
const REL_IMPORT_RE = /(?:^|[\s;])(?:import|export)[^"'`]*?from\s*["'](\.\.?\/[^"']+\.js)["']/g;
const SIDE_EFFECT_RE = /(?:^|[\s;])import\s*["'](\.\.?\/[^"']+\.js)["']/g;

function relImportsOf(absFile) {
  const src = readFileSync(absFile, "utf8");
  const out = new Set();
  for (const re of [REL_IMPORT_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      out.add(resolve(dirname(absFile), m[1]));
    }
  }
  return [...out];
}

/** Dockerfile 里 facet 角色的 COPY 清单（只认末段落到 ./facet/ 且逐列 .js 的那一行）。 */
export function shippedFacetFiles(dockerfileText) {
  const target = dockerfileText
    .split("\n")
    .find(
      (l) =>
        /^\s*COPY\s/.test(l) && /\/app\/facet\/[A-Za-z0-9._-]+\.js/.test(l) && /\.\/facet\/\s*$/.test(l),
    );
  if (!target) return null;
  const names = [...target.matchAll(/\/app\/facet\/([A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]);
  return { line: target.trim(), names: [...new Set(names)] };
}

/** 从 facet/index.js 起算相对 import 传递闭包（只跟仓内 .js）。 */
export function reachableFromEntry(root) {
  const seen = new Set();
  const missing = [];
  const queue = [join(root, ENTRY)];
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (!existsSync(cur)) {
      missing.push(cur);
      continue;
    }
    for (const dep of relImportsOf(cur)) {
      if (dep.startsWith(root) && dep.endsWith(".js") && !seen.has(dep)) queue.push(dep);
    }
  }
  return { reachable: seen, missing };
}

/** 纯函数裁决：给定 Dockerfile 文本与 facet 目录状态，返回问题清单（空数组=通过）。 */
export function facetImageProblems({ root = ROOT, dockerfileText, fileExists = existsSync } = {}) {
  const text = dockerfileText ?? readFileSync(join(root, "Dockerfile"), "utf8");
  const shipped = shippedFacetFiles(text);
  if (!shipped) {
    return [
      "Dockerfile 里找不到 facet 角色的显式 COPY 行（末段落 ./facet/ 且逐列 .js 的那一行）。" +
        "若已改成整目录 COPY，请删掉本门并在文档里记录判据变更。",
    ];
  }

  const problems = [];
  const { reachable, missing } = reachableFromEntry(root);
  for (const abs of missing) problems.push(`import 目标不存在：${abs.slice(root.length + 1)}`);

  const facetDir = join(root, "facet");
  const reachableNames = [...reachable]
    .filter((p) => dirname(p) === facetDir)
    .map((p) => p.slice(facetDir.length + 1))
    .sort();

  const shippedSet = new Set(shipped.names);
  for (const name of reachableNames) {
    if (!shippedSet.has(name)) {
      problems.push(
        `缺 COPY：facet/${name} 被 facet/index.js 可达（直接或传递 import），但未在 Dockerfile facet COPY 清单里` +
          ` → 该角色会 ERR_MODULE_NOT_FOUND 崩溃循环，而 platform 角色 smoke 门抓不到。`,
      );
    }
  }
  for (const name of shipped.names) {
    if (!fileExists(join(facetDir, name))) {
      problems.push(`COPY 清单里有不存在的文件：facet/${name}（镜像构建会直接失败）`);
    } else if (!reachable.has(join(facetDir, name))) {
      problems.push(
        `清单里多列了 facet/${name}：它不在 index.js 的可达闭包里。若确为运行期需要（动态 import / 子进程脚本），` +
          `请在 Dockerfile 该行上方注明理由；否则删除，保持清单即真相。`,
      );
    }
  }
  return problems;
}

test("Dockerfile facet COPY 清单 = facet/index.js 的可达闭包", () => {
  const problems = facetImageProblems();
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("门自身有效：拿掉 mcp-registry-json.js 必须判红（2026-10-31 事故回归）", () => {
  const text = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const broken = text.replace(" /app/facet/mcp-registry-json.js", "");
  assert.notEqual(broken, text, "回归样本失效：Dockerfile 里已找不到 mcp-registry-json.js 条目");
  const problems = facetImageProblems({ dockerfileText: broken });
  assert.ok(
    problems.some((p) => p.includes("facet/mcp-registry-json.js")),
    `应该报出缺 mcp-registry-json.js，实际：${JSON.stringify(problems)}`,
  );
});

test("门自身有效：清单里写入不存在的文件必须判红", () => {
  const text = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const broken = text.replace(" /app/facet/pairing.js", " /app/facet/pairing.js /app/facet/ghost-file.js");
  const problems = facetImageProblems({ dockerfileText: broken });
  assert.ok(
    problems.some((p) => p.includes("ghost-file.js")),
    `应该报出 ghost-file.js，实际：${JSON.stringify(problems)}`,
  );
});
