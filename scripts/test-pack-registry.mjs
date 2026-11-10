#!/usr/bin/env node
// ── Pack registry unit tests (add-pack-marketplace, tasks 1.1/1.2/1.6) ───────
//
// Exercises the gateway pack registry module directly — storage CRUD
// round-trip with two versions, manifest validation rejection classes, and
// the per-author publish rate limiter. The HTTP contract on top of these
// lives in test-pack-marketplace.mjs.
//
//   node --test scripts/test-pack-registry.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createPackRegistry,
  createPublishRateLimiter,
  registerPackRoutes,
  validateManifest,
} from "../gateway/packs.js";
import { PACK_LIMITS } from "../lib/pack-manifest.js";

function validManifest(overrides = {}) {
  return {
    name: "法律-合同",
    description: "合同审查工作流",
    tags: ["法律", "合同"],
    skills: [
      {
        name: "legal-contract-workflow",
        description: "五阶段合同审查",
        content: "# 合同审查\n按阶段推进，不编造法条。",
      },
    ],
    mcpServers: [{ registryName: "law-bench" }],
    agents: [
      { id: "pack-contract-reviewer", name: "合同审查官", persona: "你是严谨的合同审查官。" },
    ],
    ...overrides,
  };
}

test("registry round-trips a pack with two immutable versions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-registry-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const author = "author@example.com";
    const { id, version } = reg.publish({ email: author, manifest: validManifest() });
    assert.equal(version, 1);
    assert.match(id, /^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url, 128 bits

    const got = reg.get(id);
    assert.equal(got.name, "法律-合同");
    assert.equal(got.authorEmail, author);
    assert.deepEqual(got.tags, ["法律", "合同"]);
    assert.equal(got.manifest.skills[0].name, "legal-contract-workflow");

    // Second publish appends v2; v1 stays retrievable and unchanged.
    const next = reg.publishVersion({
      email: author,
      id,
      manifest: validManifest({ name: "法律-合同 v2", tags: ["法律"] }),
    });
    assert.equal(next.version, 2);
    assert.equal(reg.get(id).version, 2);
    assert.equal(reg.get(id).name, "法律-合同 v2");
    const v1 = reg.getVersion(id, 1);
    assert.equal(v1.manifest.name, "法律-合同");

    // Another author cannot publish to this pack.
    assert.equal(reg.publishVersion({ email: "other@example.com", id, manifest: validManifest() }).error, "forbidden");
    assert.equal(reg.publishVersion({ email: author, id: "no-such-pack", manifest: validManifest() }).error, "not_found");
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("list, search, and tag filter see only live packs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-registry-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const a = reg.publish({ email: "a@example.com", manifest: validManifest({ name: "合同包", tags: ["法律"] }) });
    reg.publish({ email: "b@example.com", manifest: validManifest({ name: "股票包", tags: ["金融"] }) });

    let listing = reg.list({});
    assert.equal(listing.total, 2);
    assert.ok(listing.packs.some((p) => p.id === a.id));

    assert.equal(reg.list({ search: "股票" }).total, 1);
    assert.equal(reg.list({ tag: "法律" }).total, 1);
    assert.equal(reg.list({ tag: "不存在" }).total, 0);

    // Unlisting hides the pack from browse but keeps versions fetchable and
    // does not touch subscriptions.
    reg.subscribe({ email: "sub@example.com", id: a.id });
    assert.ok(reg.setUnlisted({ email: "a@example.com", id: a.id }));
    assert.equal(reg.list({}).total, 1);
    assert.equal(reg.get(a.id), null);
    assert.ok(reg.get(a.id, { includeUnlisted: true }));
    assert.equal(reg.getVersion(a.id, 1).manifest.name, "合同包");
    assert.equal(reg.subscriberCount(a.id), 1);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new version restores listing (fix-pack-relist-on-publish)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-relist-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const author = "author@example.com";

    // Author unlists, then publishes the next version: listing comes back.
    // The facetMine.unpublishNote copy and the hygiene-baseline scenario both
    // promise exactly this — before the fix nothing could clear the flag.
    const a = reg.publish({ email: author, manifest: validManifest({ name: "盯梢模板" }) });
    assert.ok(reg.setUnlisted({ email: author, id: a.id }));
    assert.equal(reg.get(a.id), null); // invisible while unlisted
    assert.equal(reg.list({}).packs.some((p) => p.id === a.id), false);

    const next = reg.publishVersion({ email: author, id: a.id, manifest: validManifest({ name: "盯梢模板 v2" }) });
    assert.equal(next.version, 2);
    assert.ok(reg.get(a.id), "publishing a new version must restore listing");
    assert.equal(reg.list({}).packs.some((p) => p.id === a.id), true);
    // Versions stay immutable through the relist — v1 is untouched.
    assert.equal(reg.getVersion(a.id, 1).manifest.name, "盯梢模板");

    // A non-author publishing against an unlisted pack stays forbidden and the
    // pack stays unlisted (the author check precedes every pack-level write).
    const b = reg.publish({ email: author, manifest: validManifest({ name: "他家包" }) });
    assert.ok(reg.setUnlisted({ email: author, id: b.id }));
    assert.equal(reg.publishVersion({ email: "other@example.com", id: b.id, manifest: validManifest() }).error, "forbidden");
    assert.equal(reg.list({}).packs.some((p) => p.id === b.id), false);

    // Publishing never flips the visibility class: a private pack's new
    // version keeps it out of the public listing.
    const p = reg.publish({ email: author, manifest: validManifest({ name: "私人包", visibility: "private" }) });
    assert.equal(reg.get(p.id).visibility, "private");
    reg.publishVersion({ email: author, id: p.id, manifest: validManifest({ name: "私人包 v2", visibility: "private" }) });
    assert.equal(reg.get(p.id).visibility, "private");
    assert.equal(reg.list({}).packs.some((x) => x.id === p.id), false);

    // A listed pack publishing a new version behaves exactly as before.
    const c = reg.publish({ email: author, manifest: validManifest({ name: "常驻包" }) });
    const before = reg.get(c.id).visibility;
    reg.publishVersion({ email: author, id: c.id, manifest: validManifest({ name: "常驻包 v2" }) });
    assert.equal(reg.get(c.id).version, 2);
    assert.equal(reg.get(c.id).visibility, before);
    assert.equal(reg.list({}).packs.some((x) => x.id === c.id), true);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("subscribe records the latest version; unsubscribe is explicit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-registry-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const { id } = reg.publish({ email: "a@example.com", manifest: validManifest() });
    const sub = reg.subscribe({ email: "sub@example.com", id });
    assert.equal(sub.version, 1);
    assert.equal(sub.manifest.skills.length, 1);
    assert.ok(reg.subscription("sub@example.com", id));
    assert.equal(reg.subscriberCount(id), 1);

    // New versions do not rewrite existing subscription records.
    reg.publishVersion({ email: "a@example.com", id, manifest: validManifest({ name: "v2" }) });
    assert.equal(reg.subscription("sub@example.com", id).version, 1);

    // Resubscribe records the then-current version.
    const resub = reg.subscribe({ email: "sub@example.com", id });
    assert.equal(resub.version, 2);

    assert.ok(reg.unsubscribe({ email: "sub@example.com", id }));
    assert.equal(reg.subscription("sub@example.com", id), null);
    assert.equal(reg.subscriberCount(id), 0);
    assert.equal(reg.subscribe({ email: "sub@example.com", id: "missing" }), null);
  } finally {
    reg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateManifest enforces the v1 content boundary", () => {
  // Valid baseline passes.
  assert.deepEqual(validateManifest(validManifest()), []);

  // MCP entries must be registry references only — no endpoints or commands.
  const withUrl = validateManifest(validManifest({ mcpServers: [{ registryName: "x", url: "https://evil.example" }] }));
  assert.equal(withUrl.length, 1);
  assert.match(withUrl[0].error, /registry servers/);
  assert.equal(withUrl[0].entry, "mcpServers[0]");

  const withCommand = validateManifest(validManifest({ mcpServers: [{ registryName: "x", command: "curl" }] }));
  assert.match(withCommand[0].error, /registry servers/);

  // Agent entries are persona-only — no endpoints, models, or credentials.
  const withBaseUrl = validateManifest(
    validManifest({ agents: [{ id: "x", name: "X", persona: "p", baseUrl: "https://x", model: "m" }] }),
  );
  assert.match(withBaseUrl[0].error, /persona-only/);
  assert.equal(withBaseUrl[0].entry, "agents[0]");

  // Skill shape: name format, unique within the pack, bounded content.
  assert.ok(validateManifest(validManifest({ skills: [{ name: "bad name!", description: "d", content: "c" }] })).length > 0);
  const dup = validManifest({
    skills: [
      { name: "same", description: "d", content: "c" },
      { name: "same", description: "d", content: "c" },
    ],
  });
  assert.ok(validateManifest(dup).some((e) => /duplicate skill name/.test(e.error)));
  assert.ok(validateManifest(validManifest({ skills: [{ name: "ok", description: "d", content: "x".repeat(64 * 1024 + 1) }] })).length > 0);

  // A pack must have at least one part; counts and tags are capped. The caps
  // are read from PACK_LIMITS: the MCP-ref ceiling has been raised once already
  // (5 → 6, add-fleet-post-model) and a hardcoded number goes stale silently.
  assert.ok(validateManifest({ name: "empty", skills: [], mcpServers: [], agents: [] }).length > 0);
  assert.ok(
    validateManifest(
      validManifest({ mcpServers: Array.from({ length: PACK_LIMITS.maxMcpRefs + 1 }, () => ({ registryName: "x" })) }),
    ).length > 0,
  );
  assert.ok(validateManifest(validManifest({ tags: Array.from({ length: PACK_LIMITS.maxTags + 1 }, (_, i) => `t${i}`) })).length > 0);
  assert.ok(validateManifest({ name: 42 }).length > 0);
});

test("publish rate limiter is per-author and windowed", () => {
  const allow = createPublishRateLimiter({ windowMs: 1000, max: 2 });
  assert.ok(allow("a@example.com"));
  assert.ok(allow("a@example.com"));
  assert.equal(allow("a@example.com"), false);
  assert.ok(allow("b@example.com")); // independent bucket
});

// ── Curation (add-facet-content-management) ─────────────────────────────────
//
// Category rides publish (author-declared, admin-retargetable), featured is
// admin-only, the listing filters by category and author-widens unlisted, and
// the manifest validator shapes the optional category slug.

test("category rides publish and curation writes follow their permission split", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pack-curation-"));
  try {
    const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
    const author = "author@example.com";
    const { id } = reg.publish({ email: author, manifest: validManifest({ category: "legal" }) });

    // Author-declared category is visible on summary surfaces.
    assert.equal(reg.get(id).category, "legal");
    assert.equal(reg.get(id).featured, false);

    // Author may retarget their own category but never feature.
    const byAuthor = reg.setCuration({ id, actor: { email: author, admin: false }, category: "lex" });
    assert.equal(byAuthor.category, "lex");
    assert.equal(reg.setCuration({ id, actor: { email: author, admin: false }, featured: true }).error, "forbidden");

    // Stranger may neither; admin may both.
    assert.equal(reg.setCuration({ id, actor: { email: "x@example.com", admin: false }, category: "nope" }).error, "forbidden");
    const byAdmin = reg.setCuration({ id, actor: { email: "ops@example.com", admin: true }, category: "daas", featured: true });
    assert.deepEqual(byAdmin, { id, category: "daas", featured: true });
    assert.equal(reg.get(id).featured, true);

    // Curation never touches visibility or listing state.
    assert.equal(reg.get(id).visibility, "public");

    // A redeclared category on a new version updates; absence keeps curated.
    reg.publishVersion({ email: author, id, manifest: validManifest({ category: "doc-studio" }) });
    assert.equal(reg.get(id).category, "doc-studio");
    reg.publishVersion({ email: author, id, manifest: validManifest() });
    assert.equal(reg.get(id).category, "doc-studio");

    assert.equal(reg.setCuration({ id: "missing", actor: { email: "ops@example.com", admin: true }, category: "x" }).error, "not_found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listing filters by category and author-widens the unlisted clause", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pack-curation-list-"));
  try {
    const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
    const author = "author@example.com";
    const a = reg.publish({ email: author, manifest: validManifest({ category: "legal" }) });
    const b = reg.publish({ email: author, manifest: validManifest({ name: "数据研究" }) });
    const c = reg.publish({ email: "other@example.com", manifest: validManifest({ name: "他家", category: "legal" }) });
    reg.setUnlisted({ email: author, id: b.id });

    const asAuthor = { email: author, admin: false };
    // Category filter is not identity-scoped: every visible legal pack lists,
    // newest first (the other author's legal pack is public).
    const legalIds = reg.list({ category: "legal", viewer: asAuthor }).packs.map((p) => p.id);
    assert.deepEqual(new Set(legalIds), new Set([a.id, c.id]));

    // author filter includes the author's unlisted pack; strangers never see it.
    const mine = reg.list({ author: author, viewer: asAuthor });
    assert.deepEqual(new Set(mine.packs.map((p) => p.id)), new Set([a.id, b.id]));
    assert.equal(
      reg.list({ author: author, viewer: { email: "stranger@example.com", admin: false } }).packs.some((p) => p.id === b.id),
      false,
    );

    // The summary carries curation state.
    assert.equal(mine.packs.find((p) => p.id === a.id).category, "legal");
    assert.equal(Boolean(mine.packs.find((p) => p.id === a.id).featured), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest validator shapes the optional category slug", () => {
  assert.equal(validateManifest(validManifest({ category: "spider-heal" })).length, 0);
  assert.ok(validateManifest(validManifest({ category: "Not A Slug" })).length > 0);
  assert.ok(validateManifest(validManifest({ category: "x".repeat(33) })).length > 0);
  assert.ok(validateManifest(validManifest({ category: 42 })).length > 0);
  assert.equal(validateManifest(validManifest()).length, 0); // absent = fine
});

// ── P3 4.4 发布→facets 计数联动 (overhaul-market-catalog-presentation) ───────
// The domain axis is stamped at mint from manifest.domain (vocabulary-filtered,
// capped), reaches the facets counts immediately, and curation edits move the
// counts — the column is the single storage truth (specs/pack-domain-taxonomy).
test("publish 的 manifest.domain 落列并即时进 facets；越词值被投影层过滤", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pack-domain-link-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const author = "domain-author@example.com";
    const a = reg.publish({ email: author, manifest: { ...validManifest(), name: "A", domain: ["legal"] } });
    const b = reg.publish({
      email: author,
      manifest: { ...validManifest(), name: "B", domain: ["investing", "not-a-domain", "risk"] },
    });

    // 列即真源：facets 只数词表内的。
    const f = reg.facets({ locale: "en" });
    const legal = f.domains.find((d) => d.slug === "legal");
    const investing = f.domains.find((d) => d.slug === "investing");
    assert.equal(legal.count, 1, "A 进 legal 计数");
    assert.equal(investing.count, 1, "B 进 investing 计数");
    assert.ok(!f.domains.some((d) => d.slug === "not-a-domain"), "越词值不进分面");
    assert.ok(legal.label, "facets 标签随 locale 投影");

    // 读面联动：list({domain}) 命中声明包；summary 带 domains 真源列。
    const hit = reg.list({ domain: "legal", viewer: null });
    assert.equal(hit.packs.filter((p) => p.id === a.id).length, 1);
    const summaryB = reg.list({ domain: "risk" }).packs.find((p) => p.id === b.id);
    assert.deepEqual(summaryB.domains.slice().sort(), ["investing", "risk"]);

    // 策展改写立即反映到计数（同列真源）。
    reg.setCuration({ id: a.id, actor: { email: author }, domains: ["knowledge"] });
    assert.equal(reg.facets().domains.find((d) => d.slug === "legal")?.count ?? 0, 0, "legal 让位（>0 计数才进 domains 分面）");
    assert.equal(reg.facets().domains.find((d) => d.slug === "knowledge").count, 1);
  } finally {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无 domain 的 manifest 落 NULL（未归类档），发布零成本兼容", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pack-domain-null-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    const p = reg.publish({ email: "plain@example.com", manifest: validManifest() });
    const summary = reg.get(p.id);
    // 未声明=列 NULL=键缺席——存量 payload 逐字节不变（兼容不变量的写面一侧）。
    assert.equal(summary.domains, undefined, "无 domain 的 summary 不带该键");
  } finally {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P3 4.6 官方发布门 (overhaul-market-catalog-presentation) ─────────────────
// The door closes ONLY for roster-official authors, ONLY with full en coverage
// of the org surface, and ONLY when the deployment opens it (design risk row:
// P4 fills coverage first — PACK_OFFICIAL_EN_GATE defaults off). A rejection
// must itemize missing field paths AND write nothing.
import express from "express";
import http from "node:http";

const OFFICIAL = "official-author@e.test";
const COMMUNITY = "community@e.test";

function gateMount() {
  const dir = mkdtempSync(path.join(tmpdir(), "pack-enge-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  const app = express();
  registerPackRoutes(app, {
    registry: reg,
    // 身份注入的最小面：门只看名册判定，测试用请求头携带身份。
    resolveUser: (req) =>
      req.headers["x-test-email"]
        ? { email: String(req.headers["x-test-email"]), groups: ["creators"] }
        : null,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: ["creators"],
    anonymousRead: true,
    officialAuthors: [OFFICIAL],
  });
  const server = http.createServer(app);
  server.listen(0);
  return { server, reg, dir };
}

const gatePublish = (server, email, manifest) =>
  fetch(`http://127.0.0.1:${server.address().port}/api/packs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-email": email },
    body: JSON.stringify({ manifest }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

function enGapManifest() {
  // Two declared skills, en overlay covers only ONE — the classic gap shape.
  const m = validManifest({ name: "双技能包" });
  m.skills = [
    { name: "skill-a", description: "甲技能", content: "# a" },
    { name: "skill-b", description: "乙技能", content: "# b" },
  ];
  m.i18n = {
    en: {
      name: "Two Skill Pack",
      description: "A two-skill workflow",
      skills: { "skill-a": { description: "Skill A" } },
      agents: { "pack-contract-reviewer": { name: "Reviewer" } },
    },
  };
  return m;
}

test("发布门关闭时（默认）名册作者照常发布——在途发布不被突然卡住", async () => {
  delete process.env.PACK_OFFICIAL_EN_GATE; // collector reads process.env per call
  const { server, reg, dir } = gateMount();
  try {
    const r = await gatePublish(server, OFFICIAL, enGapManifest());
    assert.equal(r.status, 200, JSON.stringify(r.body));
  } finally {
    server.close();
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门开·名册作者覆盖不全：422 逐项指名缺项路径且不写版本", async () => {
  process.env.PACK_OFFICIAL_EN_GATE = "1";
  const { server, reg, dir } = gateMount();
  try {
    const r = await gatePublish(server, OFFICIAL, enGapManifest());
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, "official_en_coverage_incomplete");
    const missing = r.body.coverage.missing;
    assert.ok(missing.includes("skills['skill-b'].description"), `缺项必须指名漏掉的那条技能，实际: ${JSON.stringify(missing)}`);
    // 什么都没写：名册作者一条版本都没有。
    assert.equal(reg.list({ viewer: { email: OFFICIAL, admin: true } }).total, 0);
  } finally {
    server.close();
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门开·补齐覆盖后同名册作者发布通过；社区作者永不受此门", async () => {
  process.env.PACK_OFFICIAL_EN_GATE = "1";
  const { server, reg, dir } = gateMount();
  try {
    const fixed = enGapManifest();
    fixed.i18n.en.skills["skill-b"] = { description: "Skill B" };
    fixed.i18n.en.tags = ["Law", "Contract"]; // validManifest 基轨带 2 个标签
    const ok = await gatePublish(server, OFFICIAL, fixed);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const bare = validManifest({ name: "社区裸包" }); // 无 i18n 块
    const community = await gatePublish(server, COMMUNITY, bare);
    assert.equal(community.status, 200, `社区作者不受门，实际 ${community.status}: ${JSON.stringify(community.body)}`);
  } finally {
    server.close();
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
