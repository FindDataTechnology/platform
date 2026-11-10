#!/usr/bin/env node
// ── 形态判据（classify-out-of-band-billing-rejection 1.x-3.x）────────────────
// 纯函数表驱动 + 触发接入 + error_kind 分支。I/O 全部注入，不碰真实进程。
import assert from "node:assert/strict";
import { test } from "node:test";

const { isBillingRejectionShape } = await import("../agent-runner/manager.js");

const shapeOf = (e) => isBillingRejectionShape(e);

test("1.1 SDK 措辞形态命中", () => {
  assert.equal(shapeOf(Object.assign(new Error("403 status code (no body)"), { status: 403 })), true);
  assert.equal(shapeOf(new Error("403 status code (no body)")), true);          // wx-alpha 的真实形态
  assert.equal(shapeOf(new Error("401 status code (no body)")), true);
});

test("1.1 对象带 status 字段命中", () => {
  assert.equal(shapeOf({ status: 403 }), true);
  assert.equal(shapeOf({ statusCode: 401 }), true);
  assert.equal(shapeOf({ response: { status: 403 } }), true);
});

test("1.2 反例：5xx/402/超时/普通错误不命中", () => {
  assert.equal(shapeOf(new Error("500 Internal Server Error")), false);
  assert.equal(shapeOf({ status: 402 }), false);
  assert.equal(shapeOf({ status: 500 }), false);
  assert.equal(shapeOf(Object.assign(new Error("timeout"), { code: -32001 })), false);
  assert.equal(shapeOf(null), false);
  assert.equal(shapeOf("403 status code"), false); // 非 Error 对象不算
});

// ── 3.1 error_kind: every branch the emitter can name ────────────────────────
const { turnErrorKind } = await import("../agent-runner/manager.js");

test("3.1 error_kind 逐分支：timeout / child_exit / llm_failed / billing_unconfirmed / 无名", () => {
  // A budget kill is the timeout class — the marker+codes pair, not the code alone.
  assert.equal(turnErrorKind(Object.assign(new Error("timeout"), { code: -32001 }), { budgetKilled: true }), "timeout");
  assert.equal(turnErrorKind(Object.assign(new Error("child gone"), { code: -32002 })), "child_exit");
  assert.equal(turnErrorKind(Object.assign(new Error("llm failed"), { code: -32003 })), "llm_failed");
  // The out-of-band shape is named as UNCONFIRMED — the probe decides later.
  assert.equal(turnErrorKind(new Error("403 status code (no body)")), "billing_unconfirmed");
  assert.equal(turnErrorKind({ status: 401 }), "billing_unconfirmed");
  // No form applies → undefined, so the emitter omits the field instead of null.
  assert.equal(turnErrorKind(new Error("something else")), undefined);
  assert.equal(turnErrorKind(Object.assign(new Error("timeout"), { code: -32001 })), undefined, "code alone is not the budget kill");
  assert.equal(turnErrorKind(null), undefined);
});

test("3.3 billing_rejected 永远不出现在 turn_ended 的取值集合里", () => {
  const named = [
    turnErrorKind(Object.assign(new Error("x"), { code: -32001 }), { budgetKilled: true }),
    turnErrorKind(Object.assign(new Error("x"), { code: -32002 })),
    turnErrorKind(Object.assign(new Error("x"), { code: -32003 })),
    turnErrorKind(new Error("403 status code (no body)")),
    turnErrorKind(new Error("x")),
  ].filter(Boolean);
  assert.ok(!named.includes("billing_rejected"), "确认判决只属于 park 事件");
  assert.deepEqual([...new Set(named)].sort(), ["billing_unconfirmed", "child_exit", "llm_failed", "timeout"]);
});
