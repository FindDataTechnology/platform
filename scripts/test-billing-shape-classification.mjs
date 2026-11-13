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
