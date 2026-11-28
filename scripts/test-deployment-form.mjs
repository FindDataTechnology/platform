// 部署归属判定的单测（single-tenant-model-lane 1.1，tasks 1.1/2.2）。
//
// 这套用例的重心是**缺省落在安全侧**：未声明、写错、写空，都必须是不覆盖。
// 判反的代价不对称，所以「识别不出的值 ⇒ shared」不是随手写的 fallback，
// 是这一组断言存在的理由。
//
// 跑法：node --test scripts/test-deployment-form.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORM_CELL,
  FORM_SHARED,
  FORM_SINGLE_TENANT,
  deploymentForm,
  fallsBackOnStale,
  modelLaneOwner,
} from "../lib/deployment-form.js";

// ── 1.1 deploymentForm 六臂 ────────────────────────────────────────────────

test("1.1 有 CELL_USER_EMAIL ⇒ cell（优先于 SINGLE_TENANT）", () => {
  assert.equal(deploymentForm({ CELL_USER_EMAIL: "a@x.com" }), FORM_CELL);
  // 两者同时出现是配置矛盾：取语义更窄的 cell（身份是真实的，单租户标记是部署级的）
  assert.equal(
    deploymentForm({ CELL_USER_EMAIL: "a@x.com", SINGLE_TENANT: "1" }),
    FORM_CELL,
  );
});

test("1.1 SINGLE_TENANT 的真值写法 ⇒ single-tenant", () => {
  for (const raw of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
    assert.equal(deploymentForm({ SINGLE_TENANT: raw }), FORM_SINGLE_TENANT, `SINGLE_TENANT=${raw}`);
  }
});

test("1.1 未设 / 空 / 假值 ⇒ shared（缺省必须是不覆盖）", () => {
  const cases = [undefined, "", "  ", "0", "false", "no", "off", "random"];
  for (const raw of cases) {
    const env = raw === undefined ? {} : { SINGLE_TENANT: raw };
    assert.equal(deploymentForm(env), FORM_SHARED, `SINGLE_TENANT=${JSON.stringify(raw)}`);
  }
});

test("1.1 空 CELL_USER_EMAIL 不当作 cell", () => {
  assert.equal(deploymentForm({ CELL_USER_EMAIL: "   " }), FORM_SHARED);
  assert.equal(deploymentForm({ CELL_USER_EMAIL: "" }), FORM_SHARED);
});

test("1.1 默认读 process.env（不传参也能用）", () => {
  // 只断言形状，不改全局 env：这是「调用点可以省略参数」的证明
  assert.ok([FORM_CELL, FORM_SINGLE_TENANT, FORM_SHARED].includes(deploymentForm()));
});

// ── 2.2 modelLaneOwner 三级解析 ────────────────────────────────────────────

test("2.2 cell 形态取 CELL_USER_EMAIL", () => {
  assert.equal(
    modelLaneOwner({ CELL_USER_EMAIL: "cell@x.com" }, FORM_CELL, "bind@x.com"),
    "cell@x.com",
  );
});

test("2.2 单租户：CELL_USER_EMAIL → 绑定身份 → owner@local", () => {
  const env = {};
  // 二级：绑定时使用的平台身份
  assert.equal(modelLaneOwner(env, FORM_SINGLE_TENANT, "bind@x.com"), "bind@x.com");
  // 三级：都没有时的部署级占位（与 AUTH_MODE=none 建团队的 ownerEmail 同口径）
  assert.equal(modelLaneOwner(env, FORM_SINGLE_TENANT, null), "owner@local");
  assert.equal(modelLaneOwner(env, FORM_SINGLE_TENANT, "  "), "owner@local");
});

test("2.2 shared 形态没有归属身份（返回 null = 不覆盖）", () => {
  assert.equal(modelLaneOwner({}, FORM_SHARED, "bind@x.com"), null);
});

test("2.2 行业线变量不得当身份", () => {
  // ERP_TENANT_ID 表达的是「哪个租户的数据」，不是「谁的调用」。
  // 混用会让不同线互相污染 —— 这条断言钉住「别顺手复用它」。
  const owner = modelLaneOwner({ ERP_TENANT_ID: "acme" }, FORM_SINGLE_TENANT, null);
  assert.equal(owner, "owner@local");
  assert.notEqual(owner, "acme");
});

// ── 3.1 断线语义分叉 ───────────────────────────────────────────────────────

test("3.1 只有单租户不回落；cell 与 shared 保持既有回落语义", () => {
  assert.equal(fallsBackOnStale(FORM_SINGLE_TENANT), false);
  assert.equal(fallsBackOnStale(FORM_CELL), true);
  assert.equal(fallsBackOnStale(FORM_SHARED), true);
});
