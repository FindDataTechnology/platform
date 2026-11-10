// 回归：凭证变更后的 profile 重算绝不允许「变窄」。
//
// 2026-11-08 产上实锤：续期写入后平台用会话 groups（空数组）重算 profile，而
// dsh-profile 的可见性门是 `userGroups !== null` 才过滤 → 按组可见的
// fd-open-data-mcp / fd-daas-mcp / fd-cn-report / fd-find-data-business-mcp /
// fd-text-core 被静默删掉（35 源 → 30 源，日志只有 omit 行、无报错）。
//
// 锁两件事：
//   1. 空数组 / undefined 必须归一成 null（= 组未知，不过滤）；
//   2. reapplyProfile 必须走这条归一（源码级断言，防止有人把 helper 绕回直传）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { profileGroupsForReapply } from "../server/routes/registry.js";

test("空组集归一成 null（组未知不过滤，绝不删源）", () => {
  assert.equal(profileGroupsForReapply([]), null);
  assert.equal(profileGroupsForReapply(undefined), null);
  assert.equal(profileGroupsForReapply(null), null);
  assert.equal(profileGroupsForReapply(""), null);
  assert.equal(profileGroupsForReapply({}), null, "非数组不可信，按未知处理");
  assert.equal(profileGroupsForReapply("analysts"), null, "字符串不是组集");
});

test("有真实组时原样传下去（让带组写入正常收敛）", () => {
  const groups = ["org-demo-id", "analysts"];  // 不用真实组织 ID：公共快照禁扫规则会拦
  assert.deepEqual(profileGroupsForReapply(groups), groups);
  assert.deepEqual(profileGroupsForReapply(["platform"]), ["platform"]);
});

test("reapplyProfile 走归一 helper（不得直传 groups）", async () => {
  const src = await readFile(new URL("../server/routes/registry.js", import.meta.url), "utf8");
  assert.match(src, /profileGroupsForReapply\(groups\)/, "reapplyProfile 必须归一后再传");
  assert.doesNotMatch(
    src,
    /dshUpdateMcp\?\.\(ctx\.runtimeMcpOverlay \?\? null, groups, email\)/,
    "不得再把原始 groups 直接传给 dshUpdateMcp（空数组会删掉按组可见的源）",
  );
});
