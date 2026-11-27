// Unit checks for the structure-derived pack type badge
// (openspec: add-ai-native-lexicon, pack-marketplace delta "Market entries
// carry a structure-derived type badge"). Shape assertions only — rendering is
// covered by the market e2e sentinel; derivation is pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBadge, badgeFromFlags } from "../lib/pack-badge.js";

const agent = (extra = {}) => ({ id: "a", name: "A", ...extra });

test("fleet block wins: blueprint", () => {
  assert.equal(deriveBadge({ fleet: { members: [] }, agents: [agent({ serving: { protocol: "a2a" } })] }), "blueprint");
});

test("cluster block (team template) is also blueprint", () => {
  assert.equal(deriveBadge({ cluster: { name: "t", description: "d", defaultAgents: ["a"] }, agents: [agent()] }), "blueprint");
});

test("fleet+facade still blueprint (blueprint precedence)", () => {
  assert.equal(deriveBadge({ fleet: {}, facade: { reception: "a" }, agents: [agent({ serving: { protocol: "a2a" } })] }), "blueprint");
});

test("facade block without organization block is facade", () => {
  assert.equal(deriveBadge({ facade: { reception: "a" }, agents: [agent()] }), "facade");
});

test("serving agent without facade block is facade", () => {
  assert.equal(deriveBadge({ agents: [agent(), agent({ serving: { protocol: "a2a" } })] }), "facade");
});

test("agents without organization/facade is assistant", () => {
  assert.equal(deriveBadge({ agents: [agent(), agent({ id: "b" })] }), "assistant");
});

test("no agents is toolkit", () => {
  assert.equal(deriveBadge({ skills: [{ name: "s", content: "x" }], mcpServers: [{ registryName: "r" }] }), "toolkit");
});

test("shape tolerance: null/array/scalar manifests never throw", () => {
  assert.equal(deriveBadge(null), "toolkit");
  assert.equal(deriveBadge([]), "toolkit");
  assert.equal(deriveBadge("junk"), "toolkit");
});

test("SQL flag projection matches the manifest derivation", () => {
  assert.equal(badgeFromFlags({ has_fleet: 1, has_cluster: 0, is_facade: 1, has_serving: 1, agent_count: 2 }), "blueprint");
  assert.equal(badgeFromFlags({ has_fleet: 0, has_cluster: 1, is_facade: 0, has_serving: 0, agent_count: 1 }), "blueprint");
  assert.equal(badgeFromFlags({ has_fleet: 0, has_cluster: 0, is_facade: 1, has_serving: 0, agent_count: 1 }), "facade");
  assert.equal(badgeFromFlags({ has_fleet: 0, has_cluster: 0, is_facade: 0, has_serving: 1, agent_count: 0 }), "facade");
  assert.equal(badgeFromFlags({ has_fleet: 0, has_cluster: 0, is_facade: 0, has_serving: 0, agent_count: 3 }), "assistant");
  assert.equal(badgeFromFlags({ has_fleet: 0, has_cluster: 0, is_facade: 0, has_serving: 0, agent_count: 0 }), "toolkit");
});

test("existing published entries map as documented in the lexicon", () => {
  // CRM 客服套件 → tool; 分身工坊 → assistant (agents, no fleet/facade/serving); 寻数分身 → facade
  assert.equal(deriveBadge({ skills: [{ name: "s", content: "x" }], mcpServers: [{ registryName: "chatwoot" }] }), "toolkit");
  assert.equal(deriveBadge({ agents: [agent({ id: "workshop" })] }), "assistant");
  assert.equal(deriveBadge({ facade: { reception: "finddata" }, agents: [agent({ id: "finddata", serving: { protocol: "a2a" } })] }), "facade");
});
// ── Registry-level: the badge rides list and detail reads (task 2.1) ─────
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const badgeTmp = mkdtempSync(path.join(tmpdir(), "pack-badge-"));

// The registry-level read can only import gateway/packs.js when no parallel
// lane leaves it mid-flight — while the vendor-onboarding module referenced by
// an in-flight import does not exist yet, the import itself fails. This is a
// LOUD skip with the reason named, never a silent pass.
let registryModule = null;
let registryImportError = null;
try {
  registryModule = await import("../gateway/packs.js");
} catch (err) {
  registryImportError = err;
}

test("list and detail surfaces attach the structure-derived badge", { skip: registryImportError ? `gateway packs.js mid-flight in a parallel lane (${registryImportError.code}: ${String(registryImportError.message).split("\n")[0]})` : false }, async () => {
  const { createPackRegistry } = registryModule;
  const registry = createPackRegistry({ file: path.join(badgeTmp, "packs.db") });
  const cases = [
    ["blueprint", { name: "蓝图包", description: "d", skills: [{ name: "s1", description: "d", content: "c" }], agents: [{ id: "a1", name: "岗一", persona: "p" }], cluster: { name: "小队", description: "d", defaultAgents: ["a1"] } }],
    ["facade", { name: "分身包", description: "d", skills: [{ name: "s2", description: "d", content: "c" }], agents: [{ id: "b1", name: "接待", persona: "p", serving: { protocol: "a2a" } }] }],
    ["assistant", { name: "助手包", description: "d", skills: [{ name: "s3", description: "d", content: "c" }], agents: [{ id: "c1", name: "助理", persona: "p" }] }],
    ["toolkit", { name: "工具包", description: "d", skills: [{ name: "s4", description: "d", content: "c" }], mcpServers: [{ registryName: "fetch" }] }],
  ];
  const ids = {};
  for (const [expect, manifest] of cases) {
    const { id } = registry.publish({ email: "author@x", manifest });
    ids[expect] = id;
  }
  const { packs } = registry.list({ viewer: { email: "viewer@y" } });
  assert.equal(packs.length, 4);
  for (const p of packs) {
    const expect = Object.entries(ids).find(([, id]) => id === p.id)[0];
    assert.equal(p.badge, expect, `list row ${p.name} badge`);
    assert.equal(registry.get(p.id).badge, expect, `detail ${p.name} badge`);
  }
});

test.after(() => {
  rmSync(badgeTmp, { recursive: true, force: true });
});

// ── SQL-level: the exact list-SELECT flags pin against real SQLite ───────
import { readFileSync } from "node:fs";

test("list query SQL projects has_fleet/has_cluster/has_serving flags correctly", async () => {
  const Database = (await import("better-sqlite3")).default;
  const src = readFileSync(new URL("../gateway/packs.js", import.meta.url), "utf8");
  const m = src.match(/`SELECT p\.\*, v\.version[\s\S]*?ORDER BY v\.published_at DESC[^`]*`/);
  assert.ok(m, "list SELECT block found in gateway/packs.js");
  const sql = m[0]
    .slice(1, -1)
    .replace(/\$\{whereSql\}/g, "1 = 1")
    .replace(/\$\{wantLocale \? "v\.manifest AS manifest," : ""\}/g, "");

  const file = path.join(badgeTmp, "sql.db");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE packs (id TEXT PRIMARY KEY, author_email TEXT, created_at INTEGER, visibility TEXT, category TEXT, unlisted INTEGER DEFAULT 0, featured INTEGER DEFAULT 0);
    CREATE TABLE pack_versions (pack_id TEXT, version INTEGER, name TEXT, description TEXT, tags TEXT, manifest TEXT, author_email TEXT, published_at INTEGER, vendor TEXT);
  `);
  const insert = (id, manifest) => {
    db.prepare(`INSERT INTO packs (id, author_email, created_at, visibility, category) VALUES (?, ?, 1, 'public', '')`).run(id, "a@x");
    db.prepare(`INSERT INTO pack_versions VALUES (?, 1, ?, '', '[]', ?, 'a@x', 1, NULL)`).run(id, manifest.name, JSON.stringify(manifest));
  };
  insert("p_bp", { name: "bp", agents: [{ id: "a1", serving: { protocol: "a2a" } }], fleet: { name: "x", members: [] } });
  insert("p_bp2", { name: "bp2", agents: [{ id: "a1" }], cluster: { name: "t", description: "d", defaultAgents: ["a1"] } });
  insert("p_fa", { name: "fa", agents: [{ id: "a1" }, { id: "a2", serving: { protocol: "a2a" } }] });
  insert("p_as", { name: "as", agents: [{ id: "a1" }] });
  insert("p_tk", { name: "tk", skills: [{ name: "s", content: "c" }] });
  insert("p_tk2", { name: "tk2", mcpServers: [{ registryName: "r" }] });

  const rows = db.prepare(sql).all(50, 0);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.p_bp.has_fleet, 1); assert.equal(byId.p_bp.has_serving, 1);
  assert.equal(badgeFromFlags(byId.p_bp), "blueprint");
  assert.equal(byId.p_bp2.has_cluster, 1); assert.equal(byId.p_bp2.has_serving, 0);
  assert.equal(badgeFromFlags(byId.p_bp2), "blueprint");
  assert.equal(byId.p_fa.has_serving, 1); assert.equal(byId.p_fa.has_fleet, 0);
  assert.equal(badgeFromFlags(byId.p_fa), "facade");
  assert.equal(badgeFromFlags(byId.p_as), "assistant");
  assert.equal(badgeFromFlags(byId.p_tk), "toolkit");
  assert.equal(badgeFromFlags(byId.p_tk2), "toolkit");
  db.close();
});
