// facet marketplace.json 端点（add-ecosystem-bridge 2.5；wire-marketplace-json-curation）
// 公开面形状：策展收录（category∨featured）、白名单覆写、插件树
// （plugin.json/SKILL.md/README）、缓存头。
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

test("marketplace.json：策展在列（category∨featured）、未策展缺席、缓存头 ≤1h", async () => {
  const { registry, base, cleanup } = await boot();
  try {
    const { a, c } = await seed(registry);
    const r = await fetch(`${base}/api/marketplace/marketplace.json`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") || "", /max-age=(\d+)/);
    assert.ok(Number(r.headers.get("cache-control").match(/max-age=(\d+)/)[1]) <= 3600);
    // 默认口径（wire-marketplace-json-curation / D5）：未策展公开包不进清单，
    // 但插件树直链仍可取（清单管发现，不管可达）。
    assert.deepEqual((await r.json()).plugins.map((p) => p.name), []);
    const tree = await fetch(`${base}/api/marketplace/packs/${a.id}/v1/.claude-plugin/plugin.json`);
    assert.equal(tree.status, 200);
    // category 一档即收录。
    registry.setCuration({ id: a.id, actor: { email: "op@finddata.cloud", admin: true }, category: "legal", featured: false });
    const doc1 = await (await fetch(`${base}/api/marketplace/marketplace.json`)).json();
    assert.deepEqual(doc1.plugins.map((p) => p.name), [a.id]);
    const e1 = doc1.plugins.find((p) => p.name === a.id);
    assert.equal(e1.source, `./packs/${a.id}/v1`);
    assert.equal(e1.category, "legal");
    assert.equal(e1.featured, false);
    // featured 单独为真也收录（category 空）。
    registry.setCuration({ id: c.id, actor: { email: "op@finddata.cloud", admin: true }, category: "", featured: true });
    const doc2 = await (await fetch(`${base}/api/marketplace/marketplace.json`)).json();
    // DESC listing is newest-first; equal-second publishes fall to rowid DESC,
  // so the order is deterministic regardless of clock precision.
  assert.deepEqual(doc2.plugins.map((p) => p.name), [c.id, a.id]);
    const e2 = doc2.plugins.find((p) => p.name === c.id);
    assert.equal(e2.category, "");
    assert.equal(e2.featured, true);
  } finally { await cleanup(); }
});

test("FACET_MARKETPLACE_PACK_IDS 白名单覆写（可列未策展包，不经策展二次过滤）", async () => {
  const { registry, base, cleanup } = await boot();
  process.env.FACET_MARKETPLACE_PACK_IDS = "";
  try {
    const { a, b, c } = await seed(registry); // 全部未策展
    process.env.FACET_MARKETPLACE_PACK_IDS = `${b.id},${c.id}`;
    const doc = await (await fetch(`${base}/api/marketplace/marketplace.json`)).json();
    // 覆写语义：未策展的 c 在册即列；可见性门独立于白名单（unlisted 的 b 仍缺席）。
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
    registry.setCuration({ id: a.id, actor: { email: "op@finddata.cloud", admin: true }, category: "legal" });
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
    const { a, b } = await seed(registry); // b 已 unlisted
    registry.setCuration({ id: a.id, actor: { email: "op@finddata.cloud", admin: true }, category: "legal" }); // 让清单非空，断言才有咬合
    const pj = await fetch(`${base}/api/marketplace/packs/${b.id}/v1/.claude-plugin/plugin.json`);
    assert.equal(pj.status, 404);
    const sk = await fetch(`${base}/api/marketplace/packs/${b.id}/v1/skills/skill-B/SKILL.md`);
    assert.equal(sk.status, 404);
    assert.ok((await (await fetch(`${base}/api/marketplace/marketplace.json`)).json()).plugins.every((p) => p.name !== b.id));
  } finally { await cleanup(); }
});
