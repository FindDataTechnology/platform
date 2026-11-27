// ── 显示字段缺口对账（surface-display-field-gaps 1.1 / 1.3）─────────────────
//
// 三条判据：
//   · 缺就是缺 —— 没有 `promise` 的包必须被报出来，哪怕卡片能用描述首句降级；
//   · 全声明 ⇒ 无缺口；
//   · 与 en 覆盖分母分离 —— 一个「声明了 promise 但没翻成英文」的包，缺口视图
//     不报、覆盖看板报。两个视图问的不是同一件事。
//
//   node --test scripts/test-display-field-gaps.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackRegistry } from "../gateway/packs.js";
import { DISPLAY_FIELDS } from "../lib/pack-manifest.js";
import { localeCoverage } from "../lib/pack-locale-coverage.js";

/** A real registry on a throwaway file, seeded through the publish path so the
 *  stored manifest is byte-what production stores. */
function registryWith(packs) {
  const dir = mkdtempSync(join(tmpdir(), "fd-gaps-"));
  const registry = createPackRegistry({ file: join(dir, "packs.db") });
  for (const p of packs) registry.publish({ email: "a@b.c", manifest: p.manifest });
  return { registry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const FULL = {
  name: "全声明包",
  description: "d",
  identity: { mark: { kind: "glyph", value: "律" }, accent: "wire" },
  promise: "一屏可见的风险清单。",
  audience: ["legal"],
  outcomes: [{ title: "风险清单", detail: "逐条定位" }, { title: "修订建议" }],
  examples: [{ title: "问风险", prompt: "这条有什么风险" }, { title: "要建议", prompt: "怎么改" }],
  domain: ["legal"],
};

const BARE = { name: "只有描述的包", description: "一句介绍。第二句不该顶替承诺。" };

// 声明了 promise 但没写 i18n.en —— 覆盖看板报缺口、缺口视图不报。
const ZH_ONLY = { ...FULL, name: "只写中文的包", i18n: {} };

test("没有 promise 的包被报为缺口（降级渲染不算覆盖）", () => {
  const { registry, cleanup } = registryWith([{ manifest: BARE }]);
  const rows = registry.displayFieldGaps();
  const bare = rows[0];
  cleanup();
  assert.ok(bare, "必须列出该包");
  assert.deepEqual(bare.present, [], "什么显示字段都没声明");
  assert.deepEqual([...bare.missing].sort(), [...DISPLAY_FIELDS].sort(), "六项全缺");
  assert.equal(bare.gapCount, DISPLAY_FIELDS.length);
});

test("全声明 ⇒ 无缺口", () => {
  const { registry, cleanup } = registryWith([{ manifest: FULL }]);
  const row = registry.displayFieldGaps()[0];
  cleanup();
  assert.deepEqual(row.missing, [], "全声明不该有缺口");
  assert.equal(row.gapCount, 0);
  assert.deepEqual([...row.present].sort(), [...DISPLAY_FIELDS].sort());
});

test("与 en 覆盖分母分离：声明了但没翻译 ⇒ 缺口视图不报、覆盖看板报", () => {
  const { registry, cleanup } = registryWith([{ manifest: ZH_ONLY }]);
  const gapRow = registry.displayFieldGaps()[0];
  assert.equal(gapRow.gapCount, 0, "显示字段都声明了 —— 缺口视图不该报");

  cleanup();
  const cov = localeCoverage(ZH_ONLY, "en");
  assert.ok(cov.missing.length > 0, "没写 i18n.en ⇒ 覆盖看板必须报缺口");
  assert.ok(cov.covered < cov.total, "覆盖不足");
});

test("只报 latest version（旧版本全缺也不影响）", () => {
  const dir = mkdtempSync(join(tmpdir(), "fd-gaps-"));
  const registry = createPackRegistry({ file: join(dir, "packs.db") });
  const { id } = registry.publish({ email: "a@b.c", manifest: BARE });
  registry.publishVersion({ id, email: "a@b.c", manifest: FULL });
  const row = registry.displayFieldGaps().find((r) => r.id === id);
  assert.equal(row.gapCount, 0, "看 latest，不被旧版拖累");
  rmSync(dir, { recursive: true, force: true });
});

test("字段闭集只有一份定义", () => {
  const lib = readFileSync(new URL("../lib/pack-manifest.js", import.meta.url), "utf8");
  const matches = lib.match(/DISPLAY_FIELDS\s*=\s*Object\.freeze/g) ?? [];
  assert.equal(matches.length, 1, "闭集必须有且只有一处定义");
});

test("两个对账视图的标题不同词（五语各自）", () => {
  // 同一页两个百分比却不说明分母，是这一页最容易犯的错。标题不同词是第一道防线：
  // 「英文覆盖」问翻译，「显示字段缺失」问有没有写。
  for (const loc of ["en", "zh-CN", "es", "fr", "ja"]) {
    const curate = JSON.parse(
      readFileSync(new URL(`../web/src/locales/${loc}/common.json`, import.meta.url), "utf8"),
    ).facetCurate;
    const gapsTitle = curate?.gaps?.title;
    const covTitle = curate?.coverageLabel;
    assert.ok(gapsTitle, `${loc}: 缺 facetCurate.gaps.title`);
    assert.ok(covTitle, `${loc}: 缺 facetCurate.coverageLabel`);
    assert.notEqual(gapsTitle, covTitle, `${loc}: 两个视图标题相同（${gapsTitle}）——读者会以为是同一件事`);
  }
});
