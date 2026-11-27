// ── 一个概念一个词：产物卡 vs 看板 vs 监控（overhaul-pack-detail-presentation 6.3 / 9.2）
//
// `lib/board-spec.js` 头注写明混用是真实失败模式：board 说「这支队产出什么」，
// console 说「主人怎么看它」，两者在 manifest 校验里**闭集互斥**。展示层如果
// 两者都叫「看板」，这个分界在读者眼里就不存在。
//
// 同时钉住导航与段内标题同字（facet/web/DESIGN.md §9）：此前导航叫 Board、
// 段内叫 Dashboard，五语里四种不一致。
//
//   node --test scripts/test-pack-detail-naming.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["en", "zh-CN", "es", "fr", "ja"];
const read = (loc) =>
  JSON.parse(readFileSync(join(ROOT, "web", "src", "locales", loc, "common.json"), "utf8"));

test("导航的 board 与段内标题同字（五语各自）", () => {
  for (const loc of LOCALES) {
    const d = read(loc);
    const nav = d.packPage?.sections?.board;
    const heading = d.packs?.specSheet?.dashboardTitle;
    assert.equal(nav, heading, `${loc}: 导航「${nav}」与段标题「${heading}」不一致——一名一概念`);
  }
});

test("产物卡（output）与看板（dashboard）不是同一个词", () => {
  for (const loc of LOCALES) {
    const d = read(loc);
    const output = d.packs?.specSheet?.output;
    const board = d.packs?.specSheet?.dashboardTitle;
    const navOutput = d.packPage?.sections?.output;
    assert.ok(output, `${loc}: 缺 packs.specSheet.output`);
    assert.ok(navOutput, `${loc}: 缺 packPage.sections.output`);
    assert.notEqual(output, board, `${loc}: 「产出什么」与「看板」用了同一个词——两个概念被合并`);
    assert.equal(output, navOutput, `${loc}: 产物卡段的导航与标题必须同字`);
  }
});

test("验收 / 监控 / 产物卡的导航标签五语齐全且互不相同", () => {
  for (const loc of LOCALES) {
    const d = read(loc);
    const secs = d.packPage?.sections ?? {};
    for (const id of ["acceptance", "monitoring", "output", "toolkit"]) {
      assert.ok(typeof secs[id] === "string" && secs[id].trim(), `${loc}: packPage.sections.${id} 缺失`);
    }
    const labels = ["acceptance", "monitoring", "output"].map((id) => secs[id]);
    assert.equal(new Set(labels).size, 3, `${loc}: 三个段名不应重复（${labels.join(" / ")}）`);
  }
});

test("渲染层用各自的段名，不回落到 dashboardTitle", () => {
  // acceptance/monitoring 的渲染已抽到 ContractSections（surface-team-contract-
  // on-console），三处消费共用一份——所以键的引用在那里查，不在 AgentSpecSheet。
  const sheet = readFileSync(join(ROOT, "web", "src", "components", "packs", "AgentSpecSheet.tsx"), "utf8");
  for (const key of ["packs.specSheet.output", "packs.specSheet.dashboardTitle"]) {
    assert.match(sheet, new RegExp(key.replace(/\./g, "\\.")), `AgentSpecSheet 必须引用 ${key}`);
  }
  const contract = readFileSync(join(ROOT, "web", "src", "components", "packs", "ContractSections.tsx"), "utf8");
  for (const key of ["packs.specSheet.acceptance", "packs.specSheet.monitoring"]) {
    assert.match(contract, new RegExp(key.replace(/\./g, "\\.")), `ContractSections 必须引用 ${key}`);
  }
  // AgentSpecSheet 不得自己再造一份 acceptance/monitoring 的段名
  assert.doesNotMatch(sheet, /packs\.specSheet\.acceptance/, "契约渲染已抽走，本文件不该再有它");
});
