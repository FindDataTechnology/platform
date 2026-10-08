// facet marketplace.json 端点（add-ecosystem-bridge 2.5）
// 公开面形状：非公开缺席、精选过滤、插件树（plugin.json/SKILL.md/README）、缓存头。
// 运行：node --test scripts/test-facet-marketplace-json.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { pathToFileURL } from "node:url";

const MOD = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "facet", "marketplace-json.js");
const { registerMarketplaceJson } = await import(pathToFileURL(MOD).href);
const packsMod = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "gateway", "packs.js")).href);

async function boot() {
  const dir = await mkdtemp(path.join(tmpdir(), "facet-mkt-"));
  const registry = packsMod.createPackRegistry({ file: path.join(dir, "packs.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerMarketplaceJson(app, { registry, resolveUser: () => null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cleanup = async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { registry, base, cleanup };
}

const MANIFEST = (n) => ({
  name: `Pack ${n}`,
  description: `${n} 描述`,
  skills: [{ name: `skill-${n}`, description: `技能 ${n}`, content: `\n# ${n} 正文\n` }],
  mcpServers: n === "A" ? [{ registryName: "law-bench", requiredGroup: "legal" }] : [],
});

async function seed(registry) {
  const a = registry.publish({ email: "op@finddata.tech", manifest: MANIFEST("A") });
  const b = registry.publish({ email: "op@finddata.tech", manifest: MANIFEST("B") });
  const c = registry.publish({ email: "op@finddata.tech", manifest: MANIFEST("C") });
  registry.setUnlisted({ email: "op@finddata.tech", id: b.id });
  return { a, b, c };
}

test("marketplace.json：公开在列、unlisted/private 缺席、缓存头 ≤1h", async () => {
  const { registry, base, cleanup } = await boot();
  try {
    const { a, c } = await seed(registry);
    const r = await fetch(`${base}/api/marketplace/marketplace.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") || "", /max-age=(\d+)/);
    assert.ok(Number(r.headers.get("cache-control").match(/max-age=(\d+)/)[1]) <= 3600);
    const doc = await r.json();
    const ids = doc.plugins.map((p) => p.name);
    assert.ok(ids.includes(a.id) && ids.includes(c.id));
    assert.equal(ids.includes(a.id) && ids.includes(c.id) ? ids.length : 0, 2); // 恰两个
    const entry = doc.plugins.find((p) => p.name === a.id);
    assert.equal(entry.source, `./packs/${a.id}/v1`);
  } finally { await cleanup(); }
});

test("FACET_MARKETPLACE_PACK_IDS 精选过滤", async () => {
  const { registry, base, cleanup } = await boot();
  process.env.FACET_MARKETPLACE_PACK_IDS = "";
  try {
    const { a, c } = await seed(registry);
    process.env.FACET_MARKETPLACE_PACK_IDS = c.id;
    const doc = await (await fetch(`${base}/api/marketplace/marketplace.json`)).json();
    assert.deepEqual(doc.plugins.map((p) => p.name), [c.id]);
    process.env.FACET_MARKETPLACE_PACK_IDS = a.id;
    const doc2 = await (await fetch(`${base}/api/marketplace/marketplace.json`)).json();
    assert.deepEqual(doc2.plugins.map((p) => p.name), [a.id]);
  } finally {
    delete process.env.FACET_MARKETPLACE_PACK_IDS;
    await cleanup();
  }
});

test("插件树：plugin.json / SKILL.md（带 frontmatter）/ README（MCP 指引）", async () => {
  const { registry, base, cleanup } = await boot();
  try {
    const { a } = await seed(registry);
    const pj = await (await fetch(`${base}/api/marketplace/packs/${a.id}/v1/.claude-plugin/plugin.json`)).json();
    assert.equal(pj.name, a.id);
    assert.equal(pj.version, "1");

    const sk = await fetch(`${base}/api/marketplace/packs/${a.id}/v1/skills/skill-A/SKILL.md`);
    assert.equal(sk.status, 200);
    const body = await sk.text();
    assert.match(body, /^---\nname: "skill-A"\ndescription: "技能 A"\n---/);
    assert.match(body, /# A 正文/);

    const rd = await fetch(`${base}/api/marketplace/packs/${a.id}/v1/README.md`);
    const readme = await rd.text();
    assert.match(readme, /law-bench/);
    assert.match(readme, /wgk- 调用键/);
    assert.doesNotMatch(readme, /"mcpServers"/); // MCP 是指引，不是插件内 server 配置

    const readmeNoMcp = await fetch(`${base}/api/marketplace/packs/${a.id}/v1/README.md`);
    assert.ok(readmeNoMcp.ok);
  } finally { await cleanup(); }
});

test("版本不可变：v2 发布后清单指 v2，v1 插件文件仍可取", async () => {
  const { registry, base, cleanup } = await boot();
  try {
    const { a } = await seed(registry);
    registry.publishVersion({ email: "op@finddata.tech", id: a.id, manifest: { ...MANIFEST("A2"), skills: [{ name: "skill-A2", description: "新技能", content: "\n新正文\n" }] } });
    const doc = await (await fetch(`${base}/api/marketplace/marketplace.json`)).json();
    const entry = doc.plugins.find((p) => p.name === a.id);
    assert.equal(entry.version, "2");
    assert.equal(entry.source, `./packs/${a.id}/v2`);
    // 旧版本文件仍可取（不可变语义）
    const old = await fetch(`${base}/api/marketplace/packs/${a.id}/v1/skills/skill-A/SKILL.md`);
    assert.equal(old.status, 200);
    const missing = await fetch(`${base}/api/marketplace/packs/${a.id}/v2/skills/skill-A/SKILL.md`);
    assert.equal(missing.status, 404);
  } finally { await cleanup(); }
});

test("unlisted 包的插件树整体缺席", async () => {
  const { registry, base, cleanup } = await boot();
  try {
    const { b } = await seed(registry); // b 已 unlisted（a 未用，不解构）
    const pj = await fetch(`${base}/api/marketplace/packs/${b.id}/v1/.claude-plugin/plugin.json`);
    assert.equal(pj.status, 404);
    const sk = await fetch(`${base}/api/marketplace/packs/${b.id}/v1/skills/skill-B/SKILL.md`);
    assert.equal(sk.status, 404);
    assert.ok((await (await fetch(`${base}/api/marketplace/marketplace.json`)).json()).plugins.every((p) => p.name !== b.id));
  } finally { await cleanup(); }
});
