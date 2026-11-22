// board 段校验（enrich-fleet-template-member-config 4.1）。
//
// 每一条都对着一种「看起来写了、其实读不出东西」的坏设计：
//   · artifact 写成 console 块名（串门）——最常见的混用形态
//   · 有 title 但没 discipline —— 没人知道怎么填的卡
//   · board 不是数组 —— 形状错，后面所有判据都没意义
//
// Run: node --test lib/board-spec.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

const { validateBoardSection, BOARD_ARTIFACT_KINDS, BOARD_LIMITS } = await import("./board-spec.js");

const ok = (over = {}) => ({ artifact: "dashboard", title: "日报卡", discipline: "收尾投稿；列 daily_count", ...over });

test("合规的 board 段 ⇒ 无错误", () => {
  assert.deepEqual(validateBoardSection([ok(), ok({ artifact: "doc" })]), []);
});

test("artifact 写成 console 块名 ⇒ 拒收，且说明该写进 console 段", () => {
  const errs = validateBoardSection([ok({ artifact: "kpi" })]);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, "board_artifact_is_console_block");
  assert.ok(errs[0].error.includes("console BLOCK id"));
  assert.ok(errs[0].error.includes("kpi"));
});

test("artifact 不在四个字面量里 ⇒ 拒收并列出闭集", () => {
  const errs = validateBoardSection([ok({ artifact: "chart" })]);
  assert.equal(errs[0].code, "board_artifact_unsupported");
  for (const k of BOARD_ARTIFACT_KINDS) assert.ok(errs[0].error.includes(k), k);
});

test("缺 discipline ⇒ 拒收（没人知道怎么填的卡等于没人填）", () => {
  const errs = validateBoardSection([ok({ discipline: "  " })]);
  assert.equal(errs[0].code, "board_discipline_missing");
});

test("缺 title / 超长 ⇒ 拒收", () => {
  assert.equal(validateBoardSection([ok({ title: "" })])[0].code, "board_title_missing");
  const long = validateBoardSection([ok({ title: "x".repeat(BOARD_LIMITS.maxTitleChars + 1) })]);
  assert.ok(long.some((e) => e.error.includes("at most")));
});

test("不是数组 ⇒ 单条形状错（后续判据不再逐个跑）", () => {
  const errs = validateBoardSection({ artifact: "doc" });
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, "board_not_array");
});

test("四个产物类型全部被接受（闭集完整）", () => {
  for (const k of BOARD_ARTIFACT_KINDS) {
    assert.deepEqual(validateBoardSection([ok({ artifact: k })]), [], k);
  }
});

test("两个闭集互斥：产物名与 console 块名相交就必须红", async () => {
  // 这条钉的是「互斥」本身：将来有人往 board 闭集里加一个与 console 块同名的值，
  // 这条会红——而不是等到某份包两边都写才发现。
  const { CONSOLE_BLOCK_IDS } = await import("./console-blocks-spec.js");
  const overlap = BOARD_ARTIFACT_KINDS.filter((k) => CONSOLE_BLOCK_IDS.includes(k));
  assert.deepEqual(overlap, []);
});

test("存量 KPI 磁贴形状（{key,label,note}）⇒ 点破并给改法，而不是丢一个枚举列表", () => {
  const errs = validateBoardSection([{ key: "fleet", label: "团队" }, { key: "members", label: "岗位数" }]);
  assert.equal(errs[0].code, "board_legacy_kpi_tile");
  assert.ok(errs[0].error.includes("product CARDS") && errs[0].error.includes("console"));
});
