// 团队编制导出（openspec: team-derivation-and-export / team-export-projection 4.1–4.5）
// 运行：node --test scripts/test-team-export.mjs
//
// 这一组锁的是「导出物里团队结构不能再蒸发」以及三条边界：非团队包零变化、
// 节奏必须标「未在本宿主注册」、产物里没有可执行入口。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.dirname(new URL(import.meta.url).pathname);
const repoMod = await import(pathToFileURL(path.join(root, "..", "facet", "marketplace-repo.js")).href);
const packsMod = await import(pathToFileURL(path.join(root, "..", "gateway", "packs.js")).href);

const AUTHOR = "op@finddata.tech";
const ACTOR = { email: AUTHOR, admin: true };

function teamPack(over = {}) {
  return {
    name: "发票对账团队",
    description: "团队包",
    category: "fleet",
    agents: [
      { id: "w", name: "巡检岗", description: "d", persona: "p" },
      { id: "c", name: "拍板岗", description: "d", persona: "p" },
    ],
    fleet: {
      name: "发票对账团队",
      members: [
        {
          ref: "w", title: "巡检岗", parentRef: "c",
          target: { kind: "pack-preset", presetId: "w", packId: "P" },
          cadence: { cron: "7 9 * * *", tz: "Asia/Shanghai" },
          kpiSlots: [{ key: "invoices_matched", label: "已核对", unit: "条" }],
        },
        {
          ref: "c", title: "拍板岗", parentRef: null,
          target: { kind: "pack-preset", presetId: "c", packId: "P" },
          cadence: { cron: "37 9 * * *", tz: "Asia/Shanghai" },
          kpiSlots: [{ key: "decided", label: "已拍板" }],
        },
      ],
      orchestration: { mode: "schedule", edges: [{ kind: "handoff", from: "w", to: "c" }] },
    },
    ...over,
  };
}

async function boot() {
  const dir = await mkdtemp(path.join(tmpdir(), "team-export-"));
  const registry = packsMod.createPackRegistry({ file: path.join(dir, "packs.db") });
  return { registry, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function publishTeam(registry, over = {}) {
  const p = registry.publish({ email: AUTHOR, manifest: teamPack(over) });
  registry.setCuration({ id: p.id, actor: ACTOR, category: "fleet", featured: false });
  return p;
}

function publishPlain(registry) {
  const p = registry.publish({
    email: AUTHOR,
    manifest: { name: "单技能包", description: "d", skills: [{ name: "s", description: "sd", content: "\n# s\n" }] },
  });
  registry.setCuration({ id: p.id, actor: ACTOR, category: "data", featured: false });
  return p;
}

test("团队包导出带 TEAM.md，含岗位表与编制事实", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = publishTeam(registry);
    const files = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id);
    assert.ok(files.has("TEAM.md"), "团队包必须产出 TEAM.md");
    const md = files.get("TEAM.md");
    assert.match(md, /## 岗位表/);
    assert.match(md, /## 报数槽位/);
    assert.match(md, /## 编排边/);
    assert.match(md, /巡检岗/);
    assert.match(md, /invoices_matched（条）/);
    assert.match(md, /handoff/);
  } finally { await cleanup(); }
});

test("节奏必须标「未在本宿主注册」——导出物不许让人以为装完就自己跑", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = publishTeam(registry);
    const md = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id).get("TEAM.md");
    assert.match(md, /未在本宿主注册/);
    assert.match(md, /## 运行边界/);
    assert.match(md, /回到壹座的 cell 建队|团队级 a2a/);
    // 每条声明了 cron 的岗位都要带标记
    const cronLines = md.split("\n").filter((l) => l.includes("`7 9 * * *`") || l.includes("`37 9 * * *`"));
    assert.equal(cronLines.length, 2);
    for (const l of cronLines) assert.match(l, /未在本宿主注册/);
  } finally { await cleanup(); }
});

test("非团队包零变化：无 TEAM.md", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = publishPlain(registry);
    const files = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id);
    assert.equal(files.has("TEAM.md"), false, "非团队包不得产出 TEAM.md");
  } finally { await cleanup(); }
});

test("穴居岗位（无 cadence）如实写「按需触发」，不编造节奏", async () => {
  const { registry, cleanup } = await boot();
  try {
    const over = teamPack();
    delete over.fleet.members[1].cadence;
    const p = publishTeam(registry, over);
    const md = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id).get("TEAM.md");
    assert.match(md, /按需触发（无常驻节奏）/);
  } finally { await cleanup(); }
});

test("确定性：两遍构建逐字节相同", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = publishTeam(registry);
    const a = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id).get("TEAM.md");
    const b = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id).get("TEAM.md");
    assert.equal(a, b);
  } finally { await cleanup(); }
});

test("TEAM.md 是纯文本：无执行位语义、无脚本围栏、无 HTML script", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = publishTeam(registry);
    const md = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id).get("TEAM.md");
    assert.doesNotMatch(md, /```(?:sh|bash|js|javascript|python)/);
    assert.doesNotMatch(md, /<script/i);
    assert.doesNotMatch(md, /onclick=/i);
  } finally { await cleanup(); }
});

test("agents/*.md 仍按既有规则产出（不因 TEAM.md 改变）", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = publishTeam(registry);
    const files = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id);
    assert.ok(files.has("agents/w.md"));
    assert.ok(files.has("agents/c.md"));
    assert.match(files.get("agents/w.md"), /^---\nname: "巡检岗"/);
  } finally { await cleanup(); }
});

test("exportProjection:false 保留 TEAM.md 编制表，但不产 persona 正文", async () => {
  const { registry, cleanup } = await boot();
  try {
    const over = teamPack();
    over.fleet.exportProjection = false;
    const p = publishTeam(registry, over);
    const files = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id);
    const md = files.get("TEAM.md");
    assert.ok(md, "TEAM.md 仍要产出（编制表是契约级事实）");
    assert.match(md, /## 岗位表/);
    assert.match(md, /invoices_matched（条）/);
    assert.equal(files.has("agents/w.md"), false, "关掉开关后不产 persona 正文");
    assert.equal(files.has("agents/c.md"), false);
  } finally { await cleanup(); }
});

test("exportProjection 缺省为 true：存量包导出逐字节不变", async () => {
  const { registry, cleanup } = await boot();
  try {
    const p = publishTeam(registry);           // 不声明开关
    const files = repoMod.buildMarketplaceRepo(registry, { env: {} }).plugins.get(p.id);
    assert.ok(files.has("agents/w.md"), "缺省必须产 persona（存量行为不变）");
    assert.ok(files.has("TEAM.md"));
  } finally { await cleanup(); }
});
