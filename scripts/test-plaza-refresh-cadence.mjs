// ── plaza 周期刷新的周期律（fix-supply-machine-faces 4.2）──────────────────
//
//   node --test scripts/test-plaza-refresh-cadence.mjs
//
// 4.2 的验收原文是「两次 generatedAt 相差一个周期」。该值是**日期**，同一天重跑不变，
// 所以按字面等一天才能验。这里把「周期」变成可确定性验证的东西：`runExport` 现在接受
// `now`（默认 new Date()，生产行为不变），于是「隔一天必然前进」可以直接断言，而不是等钟。
//
// 同时钉住另外三条与刷新安全性直接相关的契约：
//   · 同一天重跑幂等（cron 每天跑不会把产物搞坏）；
//   · 市场新增条目会出现在 catalog.json（验收的后半句）；
//   · 缺导出物时 plaza-stage.sh 必须拒绝落位、且站点根一字未动（不落半套）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runExport } from "./plaza-export.mjs";

const LOCALES = ["zh-CN", "en", "es", "fr", "ja"];

// 最小但过门禁的 fixture：三物种齐全、计数自洽（G1 逐项对源）。
function mkFixture() {
  const pack = (id, name, extra = {}) => ({
    id, name, description: `${name} 描述`, version: 1, category: "feat", tags: [],
    authorEmail: "fixture@example.com", createdAt: 1760000000000, updatedAt: 1760000000000,
    ...extra,
  });
  const packs = [pack("p-alpha", "Alpha 套件"), pack("p-beta", "Beta 套件")];
  return {
    marketplaceCount: packs.length,
    listingsByLocale: Object.fromEntries(LOCALES.map((l) => [l, packs])),
    skills: [{ name: "skill-one", description: "技能一：做一件事", tags: ["x"] }],
    mcpServers: [{ name: "mcp-one", displayName: "mcp-one", description: "MCP 一", endpoint: "https://example.invalid/mcp", requiredGroups: [] }],
    mcpByLocale: Object.fromEntries(LOCALES.map((l) => [l, [{ name: "mcp-one", displayName: "mcp-one", description: "MCP 一", endpoint: "https://example.invalid/mcp", requiredGroups: [] }]])),
    mcpDepths: {},
    facades: [],
    dataAnchors: [],
  };
}

function fixtureAt(dir, mutate = (fx) => fx) {
  const p = path.join(dir, "fixture.json");
  fs.writeFileSync(p, JSON.stringify(mutate(mkFixture())));
  return p;
}

const readCatalog = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "generated", "catalog.json"), "utf8"));

test("generatedAt advances exactly one period when a day passes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-cadence-"));
  const fixture = fixtureAt(dir);

  const day1 = await runExport({ fixture, outDir: path.join(dir, "generated"), now: new Date("2026-11-10T04:17:00Z") });
  assert.equal(day1.generatedAt, "2026-11-10");
  assert.equal(readCatalog(dir).generatedAt, "2026-11-10");

  const day2 = await runExport({ fixture, outDir: path.join(dir, "generated"), now: new Date("2026-11-11T04:17:00Z") });
  assert.equal(day2.generatedAt, "2026-11-11");
  assert.equal(readCatalog(dir).generatedAt, "2026-11-11");

  const gapDays = (Date.parse(day2.generatedAt) - Date.parse(day1.generatedAt)) / 86_400_000;
  assert.equal(gapDays, 1, "两次相差一个周期（一天）——这正是 4.2 的验收判据");
});

test("same-day rerun is idempotent (cron may fire more than once a day)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-idem-"));
  const fixture = fixtureAt(dir);
  const at = new Date("2026-11-11T04:17:00Z");

  await runExport({ fixture, outDir: path.join(dir, "generated"), now: at });
  const first = fs.readFileSync(path.join(dir, "generated", "catalog.json"), "utf8");
  await runExport({ fixture, outDir: path.join(dir, "generated"), now: new Date("2026-11-11T18:17:00Z") });
  const second = fs.readFileSync(path.join(dir, "generated", "catalog.json"), "utf8");

  assert.equal(first, second, "同一日期内重跑，产物逐字节一致");
});

test("a newly listed pack shows up in catalog.json on the next refresh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-newpack-"));
  const before = fixtureAt(dir);
  await runExport({ fixture: before, outDir: path.join(dir, "generated"), now: new Date("2026-11-10T04:17:00Z") });
  const idsBefore = readCatalog(dir).materials.map((m) => m.id);
  assert.equal(idsBefore.includes("p-gamma-new"), false, "新增包前一周期不在目录里");

  const after = fixtureAt(dir, (fx) => {
    const packs = [...fx.listingsByLocale["zh-CN"], { id: "p-gamma-new", name: "Gamma 新包", description: "新上架", version: 1, category: "feat", tags: [], authorEmail: "fixture@example.com", createdAt: 1760000000000, updatedAt: 1760000000000 }];
    return { ...fx, marketplaceCount: packs.length, listingsByLocale: Object.fromEntries(LOCALES.map((l) => [l, packs])) };
  });
  await runExport({ fixture: after, outDir: path.join(dir, "generated"), now: new Date("2026-11-11T04:17:00Z") });
  const idsAfter = readCatalog(dir).materials.map((m) => m.id);
  assert.ok(idsAfter.includes("p-gamma-new"), "新增条目在下一周期出现在 catalog.json（4.2 验收后半句）");
});

test("plaza-stage.sh refuses a bundle missing a machine face and leaves the site root untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-stage-"));
  const site = path.join(dir, "site");
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, "sentinel.txt"), "untouched");

  // 包里缺 generated/llms.txt
  const bundleSrc = path.join(dir, "bundle");
  fs.mkdirSync(path.join(bundleSrc, "generated"), { recursive: true });
  fs.writeFileSync(path.join(bundleSrc, "generated", "catalog.json"), "{}");
  fs.writeFileSync(path.join(bundleSrc, "generated", "llms-full.txt"), "x");
  const tar = path.join(dir, "bundle.tar.gz");
  execFileSync("tar", ["-czf", tar, "-C", bundleSrc, "."]);

  const stage = new URL("./plaza-stage.sh", import.meta.url).pathname;
  let failed = false;
  try {
    execFileSync("bash", [stage, tar, site], { stdio: "pipe" });
  } catch {
    failed = true;
  }
  assert.equal(failed, true, "缺机器面时必须非零退出");
  assert.equal(fs.readFileSync(path.join(site, "sentinel.txt"), "utf8"), "untouched", "站点根一字未动");
  assert.equal(fs.existsSync(path.join(site, "catalog.json")), false, "没有落半套");
});
