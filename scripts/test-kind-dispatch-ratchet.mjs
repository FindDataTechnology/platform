// 岗位类型分流的棘轮（2026-11-10）
//
// 背景：加第五种岗位承载 auditor 时，散落的 `targetKind === "persona"` 比较漏了
// 十几处，四轮才补完（模板校验/导出、实例化落地、解析/模型/归因、编导边）。
// 每一处的表现都不是报错，而是「岗位还在、名字也在，只是它不再干那件事」。
//
// 这个文件把「顺手写 === "persona"」变成会红的事：要么改用 isPersonaBackedTargetKind()
// （当你真的想指「persona 族」），要么在这一行或上一行写 `persona-only: <理由>`
// （当你确实只指 persona 本身）。两种都不做 → 测试失败。
//
// Run: node --test scripts/test-kind-dispatch-ratchet.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const REPO = new URL("../", import.meta.url).pathname;
const COMPARISON = /(?:targetKind|targetType|kind)\s*(?:===|!==)\s*"persona"|"persona"\s*(?:===|!==)/;
const ANNOTATION = /persona-only:/;

function scan() {
  const files = execSync("grep -rl '\"persona\"' server lib --include=*.js", { cwd: REPO })
    .toString()
    .trim()
    .split("\n")
    .filter((f) => f && !f.includes(".test."));
  const offenders = [];
  for (const rel of files) {
    const lines = readFileSync(`${REPO}${rel}`, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!COMPARISON.test(line)) return;
      // 已经走统一判定的，或同一行/上一行标了理由的，算过关
      if (line.includes("isPersonaBackedTargetKind")) return;
      // 回看 3 行：理由常写成多行注释，扫描器不该逼人把解释压成一行。
      const context = [line, ...lines.slice(Math.max(0, i - 3), i)].join("\n");
      if (ANNOTATION.test(context)) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return offenders;
}

test("every raw `=== \"persona\"` dispatch site is either unified or justified", () => {
  const offenders = scan();
  assert.deepEqual(
    offenders,
    [],
    `以下位置按 "persona" 直接分流，既没用 isPersonaBackedTargetKind，也没写理由。\n` +
      `若语义是「persona 族（含审计官）」→ 改用 isPersonaBackedTargetKind；\n` +
      `若确实只指 persona 本身 → 在该行或上一行写 \`persona-only: <为什么审计官不适用>\`。\n\n` +
      offenders.join("\n"),
  );
});

test("the ratchet actually bites (a synthetic offender is detected)", () => {
  // 自检：如果扫描逻辑失效（比如正则写错），这条会红——否则整个文件是假绿。
  assert.equal(COMPARISON.test('if (m.targetKind === "persona") {}'), true);
  assert.equal(COMPARISON.test('if (m.targetKind !== "persona") {}'), true);
  assert.equal(COMPARISON.test('if (isPersonaBackedTargetKind(m.targetKind)) {}'), false);
});
