// 输入卡不许被折进活动组（add-input-request-cards 线上回归，2026-11-11）：
//
// 线上形态：工具先返回「挂起中」→ 回合结束 → 活动组收起 → 卡片被折进
// 「已完成」那一行，人看不到该填的卡（冒烟判「卡片未出现」）。问询卡与确认卡
// 早就有「不许折」的规则，输入卡缺这一条。
//
// 这条钉住三种形态：调用还在跑（running）、工具已返回挂起中（done + state=pending）
// 必须展开；落终态后照常折叠。

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const { groupHasPendingInput, inputRequestStateOf } = await import(
  "../packages/core/src/store/activity-groups.ts"
);

const group = (...blocks) => ({ startIndex: 0, blocks });
const tool = (state, result = undefined) => ({
  kind: "tool",
  id: "call-1",
  name: "mcp__input-request__request_input",
  args: { card: { type: "form", title: "t", fields: [] } },
  state,
  ...(result !== undefined ? { result } : {}),
});

test("调用还在跑：展开", () => {
  assert.equal(groupHasPendingInput(group(tool("running"))), true);
});

test("工具返回挂起中（字符串结果）：展开", () => {
  const result = JSON.stringify({ requestId: "ir_1", state: "pending", awaitingAnswer: true });
  assert.equal(groupHasPendingInput(group(tool("done", result))), true);
});

test("工具返回挂起中（已解析对象）：展开", () => {
  assert.equal(groupHasPendingInput(group(tool("done", { requestId: "ir_1", state: "pending" }))), true);
});

test("落终态后照常折叠", () => {
  const answered = JSON.stringify({ requestId: "ir_1", state: "answered", values: { a: "1" } });
  assert.equal(groupHasPendingInput(group(tool("done", answered))), false);
  const cancelled = JSON.stringify({ requestId: "ir_1", state: "cancelled" });
  assert.equal(groupHasPendingInput(group(tool("done", cancelled))), false);
});

test("别的工具不触发这条规则", () => {
  const other = { ...tool("running"), name: "mcp__fleet__report_status" };
  assert.equal(groupHasPendingInput(group(other)), false);
});

test("state 读取认文本与对象两种形态，且要求 requestId", () => {
  assert.equal(inputRequestStateOf(JSON.stringify({ requestId: "x", state: "pending" })), "pending");
  assert.equal(inputRequestStateOf({ requestId: "x", state: "answered" }), "answered");
  assert.equal(inputRequestStateOf({ state: "pending" }), null, "没有 requestId 不算输入请求");
  assert.equal(inputRequestStateOf("not json"), null);
  assert.equal(inputRequestStateOf(null), null);
});
