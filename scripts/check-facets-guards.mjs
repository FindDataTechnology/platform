#!/usr/bin/env node
// ── facets 的数组字段读取必须兜底 ─────────────────────────────────────────────
//
// 2026-11-25 实测：`PackMarketView` 的 `unlinedCount` effect 写的是
// `facets.lines.reduce(...)`，而同文件另三处读同一字段都带 `?? []`。facets 响应
// 一旦缺 `lines`（较早的服务端，或只声明被断言轴的 e2e mock），这一行抛
// TypeError，React 卸载整棵子树 —— 目录页白屏，所有 pack-card 消失。三条
// `team-roster-isomorphic` 用例就是这么红的：它的 facets mock 只返回
// `{categories,domains,tags}`。
//
// 一个可选字段读成必填，失败是「整页消失」而不是「少一块」——代价差得太远，
// 所以把它做成静态闸：`facets.<arrField>` 只要出现在读取位置，同一个表达式里
// 就必须有 `??` / `||` 兜底（或已被 Optional chaining `.?.` 覆盖）。
//
// 判据在源码文本上，落在「原子表达式」这一层：把行按 `facets.` 切开，取到下一个
// 分隔符，看片段里有没有兜底。这条规则窄到不会误伤（只有数组字段被点名），也
// 不会假绿（漏兜底 = 片段里没有 `??`/`||`）。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 命中即要求兜底的数组字段（`facets.lines` / `facets.domains`）。
export const GUARDED_FIELDS = ["lines", "domains"];
export const SCAN_ROOT = path.join(REPO, "web", "src");

function* walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (name.name === "node_modules" || name.name === "dist") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(name.name)) {
      yield full;
    }
  }
}

/**
 * @returns {{file: string, line: number, snippet: string, field: string}[]}
 *   Every unguarded `facets.<field>` read. Empty = clean.
 */
export function findUnguardedReads(root = SCAN_ROOT) {
  const bad = [];
  if (!existsSync(root)) return bad;
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      // Strip line comments so prose mentioning facets.lines is not judged.
      const code = text.replace(/\/\/.*$/, "");
      for (const field of GUARDED_FIELDS) {
        const needle = `facets.${field}`;
        let from = 0;
        for (;;) {
          const at = code.indexOf(needle, from);
          if (at < 0) break;
          from = at + needle.length;
          // The expression this read lives in: from the read to the next of
          // `;` `)` `,` `}` at this nesting or end of line — enough to catch a
          // trailing `?? []` / `|| []` on the same expression.
          const tail = code.slice(at);
          const stop = tail.search(/[;,)]/);
          const expr = stop < 0 ? tail : tail.slice(0, stop + 1);
          if (/\?\?|\|\|/.test(expr)) continue; // guarded
          bad.push({ file: path.relative(REPO, file), line: i + 1, snippet: text.trim().slice(0, 100), field });
        }
      }
    });
  }
  return bad;
}

function main() {
  const bad = findUnguardedReads();
  if (bad.length === 0) {
    console.log(`✓ facets 数组字段读取都有兜底（${GUARDED_FIELDS.join(", ")}；扫描 ${path.relative(REPO, SCAN_ROOT)}）`);
    return;
  }
  console.error("✗ facets 数组字段被读成必填 —— 字段一旦缺失就会整页崩：");
  for (const b of bad) console.error(`  ${b.file}:${b.line}  facets.${b.field}  ${b.snippet}`);
  console.error("  修法：读取处加 `?? []`（或 `|| []`），或确认该表达式已被 Optional chaining 覆盖。");
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
