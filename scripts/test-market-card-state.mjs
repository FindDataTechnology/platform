// ── Market card relation state (polish-material-market-tabs 1.x / 4.1) ──────
//
//   node --test scripts/test-market-card-state.mjs
//
// 钉住的契约：
//   · 已装 ⇒ 报已装版本；线上更新 ⇒ 报可更新版本；
//   · 缺任一侧 ⇒ 两者都不报（失败的已装读取不得告诉订阅者「你没装」）；
//   · 关系态不参与任何闸——它只是呈现。
//
// 反向验证见 4.2：把「缺数据」分支改成报「已装」，本文件必须转红。

import assert from "node:assert/strict";
import { test } from "node:test";

const { packRelation, installedVersionMap } = await import("../web/src/lib/packRelation.ts");

test("not installed shows nothing at all", () => {
  assert.deepEqual(packRelation(3, null), { installedVersion: null, updateVersion: null });
  assert.deepEqual(packRelation(3, undefined), { installedVersion: null, updateVersion: null });
});

test("installed at the listed version shows only 已装", () => {
  assert.deepEqual(packRelation(3, 3), { installedVersion: 3, updateVersion: null });
});

test("installed behind the listing shows 已装 and 可更新", () => {
  assert.deepEqual(packRelation(4, 3), { installedVersion: 3, updateVersion: 4 });
});

test("installed ahead of the listing (local newer) shows only 已装", () => {
  // A locally-newer snapshot is not an update prompt: nothing to move to.
  assert.deepEqual(packRelation(2, 5), { installedVersion: 5, updateVersion: null });
});

test("an unknown listed version does not invent an update", () => {
  assert.deepEqual(packRelation(null, 3), { installedVersion: 3, updateVersion: null });
  assert.deepEqual(packRelation(undefined, 3), { installedVersion: 3, updateVersion: null });
});

test("nonsense versions are treated as unknown, never as zero", () => {
  assert.deepEqual(packRelation(0, 0), { installedVersion: null, updateVersion: null });
  assert.deepEqual(packRelation(-1, 3), { installedVersion: 3, updateVersion: null });
  assert.deepEqual(packRelation(3, Number.NaN), { installedVersion: null, updateVersion: null });
});

test("the map skips rows it cannot read", () => {
  const map = installedVersionMap([
    { packId: "a", version: 2 },
    { packId: "b", version: null },
    { packId: "  ", version: 4 },
    { packId: "c", version: 0 },
    { packId: "d" },
  ]);
  assert.deepEqual(map, { a: 2 });
  assert.deepEqual(installedVersionMap(null), {});
});

test("the relation is presentation only — it exposes no gate or action", () => {
  const relation = packRelation(4, 3);
  // Nothing in the shape can be read as "blocked" or "required": two numbers.
  assert.deepEqual(Object.keys(relation).sort(), ["installedVersion", "updateVersion"]);
  for (const value of Object.values(relation)) {
    assert.equal(typeof value === "number" || value === null, true);
  }
});
