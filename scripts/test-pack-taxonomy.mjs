#!/usr/bin/env node
// ── 分类体系（线 × 领域）tests (overhaul-market-catalog-presentation P1) ─────
//
// Pins the declared-taxonomy contract:
//   1. 词表完整性：五条线各带五语标签；每个领域项带 zh+四语；slug 形状受控
//   2. env 覆盖：合法覆盖生效，非法覆盖回落内置（两轴各自独立）
//   3. 分面形状：线恒 5 条按声明顺序（含计数 0）；领域只出的计数>0，按声明顺序；
//      label 随 locale，未知 locale 回落
//   4. 领域写面：发布盖章 / 策展词表内改写 / 词表外拒绝 / 空数组=显式清空 / 超 3 拒绝
//   5. 领域读面：list({domain}) 命中；未声明领域的条目不匹配任何领域
//
//   node --test scripts/test-pack-taxonomy.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tax = await import("../lib/pack-taxonomy.js");
const { createPackRegistry } = await import("../gateway/packs.js");

// ── 1. 词表完整性 ────────────────────────────────────────────────────────────

test("五条线：slug 受控、各自带五语标签（zh 主轨线词 + en/es/fr/ja）", () => {
  assert.deepEqual(tax.lineSlugs(), ["base", "lex", "wire", "facet", "constellation"]);
  for (const slug of tax.lineSlugs()) {
    const word = tax.lineWordOf(slug);
    assert.ok(word && /·/.test(word), `${slug} 的 zh 主轨线词缺失`);
    for (const locale of ["en", "es", "fr", "ja"]) {
      const label = tax.lineLabelOf(word, locale);
      assert.notEqual(label, word, `${slug} 缺 ${locale} 标签`);
      assert.ok(label.length > word.length / 2, `${slug} 的 ${locale} 标签异常短`);
    }
  }
});

test("领域词表：每项 slug 合法且带五语标签，顺序稳定", () => {
  const vocab = tax.domainVocabulary();
  assert.ok(vocab.length >= 8, "词表过短");
  assert.deepEqual(
    vocab.map((d) => d.slug),
    [...new Set(vocab.map((d) => d.slug))],
    "slug 重复",
  );
  for (const d of vocab) {
    assert.match(d.slug, /^[a-z][a-z0-9-]{1,31}$/);
    for (const locale of ["zh", "en", "es", "fr", "ja"]) {
      assert.equal(typeof d.labels[locale], "string");
      assert.ok(d.labels[locale].trim().length > 0, `${d.slug} 缺 ${locale} 标签`);
    }
  }
});

test("domainLabelOf：随 locale 出标签，未知 slug 原样返回", () => {
  assert.equal(tax.domainLabelOf("legal", "zh"), "法务");
  assert.equal(tax.domainLabelOf("legal", "en"), "Legal");
  assert.equal(tax.domainLabelOf("investing", "ja"), "投資調査");
  assert.equal(tax.domainLabelOf("not-a-domain", "en"), "not-a-domain");
  assert.equal(tax.domainLabelOf("legal", "de"), "法务"); // 未覆盖回落 zh
});

// ── 2. env 覆盖 ─────────────────────────────────────────────────────────────

test("PACK_DOMAIN_TAXONOMY 合法覆盖生效，非法覆盖回落内置", () => {
  tax._resetTaxonomyCache();
  const env = {
    PACK_DOMAIN_TAXONOMY: JSON.stringify([{ slug: "custom-dom", labels: { zh: "自定义", en: "Custom" } }]),
  };
  assert.deepEqual(
    tax.domainVocabulary(env).map((d) => d.slug),
    ["custom-dom"],
  );
  assert.equal(tax.domainLabelOf("custom-dom", "en", env), "Custom");
  // 词表外的内置 slug 在覆盖后不再合法
  assert.equal(tax.isDomainSlug("legal", env), false);

  // 非法覆盖（无可用项）回落内置
  const bad = { PACK_DOMAIN_TAXONOMY: JSON.stringify([{ slug: "UPPER", labels: {} }, { nope: 1 }]) };
  assert.ok(tax.domainVocabulary(bad).length >= 8);
  const malformed = { PACK_DOMAIN_TAXONOMY: "{not json" };
  assert.ok(tax.domainVocabulary(malformed).length >= 8);
  tax._resetTaxonomyCache();
});

test("PACK_CATEGORY_LINES 仍可覆盖归位表（shim 与真源同表）", () => {
  tax._resetTaxonomyCache();
  const env = { PACK_CATEGORY_LINES: JSON.stringify({ "my-vertical": "谦面 · 业务流" }) };
  assert.equal(tax.lineOf("my-vertical", env), "谦面 · 业务流");
  assert.deepEqual(tax.slugsForLine("谦面 · 业务流", env), ["my-vertical"]);
  // 未映射透传不变
  assert.equal(tax.lineOf("unknown-slug", env), "unknown-slug");
  tax._resetTaxonomyCache();
});

// ── 3. 分面形状 ─────────────────────────────────────────────────────────────

function manifest(overrides = {}) {
  return {
    name: "测试包",
    description: "描述",
    tags: [],
    skills: [],
    mcpServers: [],
    agents: [],
    ...overrides,
  };
}

async function seeded() {
  const dir = mkdtempSync(path.join(tmpdir(), "taxonomy-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  const author = "a@example.com";
  const legal = reg.publish({
    email: author,
    manifest: manifest({ name: "识律包", category: "legal", domain: ["legal"] }),
  });
  const wire = reg.publish({
    email: author,
    manifest: manifest({ name: "柏讯包", category: "wire" }), // 未声明领域 → 未归类
  });
  return { reg, dir, legal, wire };
}

test("facets：线恒 5 条按声明顺序（含计数 0），领域只出计数>0 且按声明顺序", async () => {
  const { reg, dir } = await seeded();
  try {
    const f = reg.facets({ locale: "zh" });
    assert.equal(f.lines.length, 5);
    assert.deepEqual(
      f.lines.map((l) => l.slug),
      ["base", "lex", "wire", "facet", "constellation"],
    );
    const bySlug = Object.fromEntries(f.lines.map((l) => [l.slug, l]));
    assert.equal(bySlug.lex.count, 1);
    assert.equal(bySlug.wire.count, 1);
    assert.equal(bySlug.base.count, 0); // 零计数线仍在
    assert.equal(f.domains.length, 1);
    assert.equal(f.domains[0].slug, "legal");
    assert.equal(f.domains[0].count, 1);

    // label 随 locale
    const en = reg.facets({ locale: "en" });
    assert.equal(en.lines.find((l) => l.slug === "wire").label, "Wire · Data & Intelligence");
    assert.equal(en.domains[0].label, "Legal");
    // 未覆盖 locale 回落 zh
    const de = reg.facets({ locale: "de" });
    assert.equal(de.lines.find((l) => l.slug === "wire").label, "柏讯 · 数据与情报");
    assert.equal(de.domains[0].label, "法务");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facets：零计数领域不出现；线计数不随语言变", async () => {
  const { reg, dir } = await seeded();
  try {
    const zh = reg.facets({ locale: "zh" });
    const en = reg.facets({ locale: "en" });
    assert.deepEqual(
      zh.lines.map((l) => l.count),
      en.lines.map((l) => l.count),
    );
    assert.deepEqual(
      zh.domains.map((d) => d.slug),
      en.domains.map((d) => d.slug),
    );
    assert.equal(zh.domains.some((d) => d.slug === "risk"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 领域写面 ─────────────────────────────────────────────────────────────

test("发布盖章 manifest.domain；策展词表内改写；空数组显式清空", async () => {
  const { reg, dir, legal } = await seeded();
  try {
    assert.deepEqual(reg.get(legal.id)?.domains ?? [], ["legal"]);

    // 策展改写为两个词表内取值
    const r1 = reg.setCuration({ id: legal.id, actor: { email: "a@example.com", admin: false }, domains: ["legal", "risk"] });
    assert.deepEqual(r1.domains, ["legal", "risk"]);
    assert.deepEqual(reg.facets({}).domains.map((d) => d.slug).sort(), ["legal", "risk"]);

    // 词表外取值被拒，且不改写既有值
    const r2 = reg.setCuration({ id: legal.id, actor: { email: "a@example.com", admin: false }, domains: ["not-a-domain"] });
    assert.equal(r2.error, "invalid_domains");
    assert.deepEqual(reg.get(legal.id)?.domains ?? [], ["legal", "risk"]);

    // 超 3 被拒
    const r3 = reg.setCuration({ id: legal.id, actor: { email: "a@example.com", admin: false }, domains: ["legal", "risk", "ops", "content"] });
    assert.equal(r3.error, "invalid_domains");

    // 空数组 = 显式清空 → 回未归类
    const r4 = reg.setCuration({ id: legal.id, actor: { email: "a@example.com", admin: false }, domains: [] });
    assert.equal(r4.domains, undefined);
    assert.equal(reg.get(legal.id)?.domains, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非作者非管理员不可写领域", async () => {
  const { reg, dir, legal } = await seeded();
  try {
    const r = reg.setCuration({ id: legal.id, actor: { email: "stranger@example.com", admin: false }, domains: ["risk"] });
    assert.equal(r.error, "forbidden");
    assert.deepEqual(reg.get(legal.id)?.domains ?? [], ["legal"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. 领域读面 ─────────────────────────────────────────────────────────────

test("list({domain}) 只命中声明了该领域的条目；未声明者不匹配任何领域", async () => {
  const { reg, dir } = await seeded();
  try {
    const hits = reg.list({ domain: "legal" });
    assert.equal(hits.total, 1);
    assert.equal(hits.packs[0].name, "识律包");

    const none = reg.list({ domain: "risk" });
    assert.equal(none.total, 0);

    // 未声明领域的包在无筛选时照常出现
    assert.equal(reg.list({}).total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未映射类目（未归类）：不进任何线 chip，也不匹配领域筛选", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taxonomy-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    reg.publish({ email: "a@example.com", manifest: manifest({ name: "未知类目包", category: "completely-new-slug" }) });
    const f = reg.facets({});
    // 五条线的计数全 0（未映射 slug 不被当作第六条线）
    assert.equal(f.lines.length, 5);
    assert.deepEqual(
      f.lines.map((l) => l.count),
      [0, 0, 0, 0, 0],
    );
    assert.equal(f.domains.length, 0);
    // 条目本身照常可列出（present-as-is 的存储语义不变）
    assert.equal(reg.list({}).total, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. 迁移回填 ─────────────────────────────────────────────────────────────

const { planBackfill, applyBackfill } = await import("./migrate-pack-domains.mjs");

test("回填：只写推导出领域的行，已声明/未归类的保持，category 逐字节不变", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taxonomy-mig-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  try {
    // A：legal → [legal]（可推导）
    const a = reg.publish({ email: "a@example.com", manifest: manifest({ name: "识律包", category: "legal" }) });
    // B：wire（供给线，不猜领域 → 保持未归类）
    const b = reg.publish({ email: "a@example.com", manifest: manifest({ name: "柏讯包", category: "wire" }) });
    // C：已声明领域（迁移不得覆盖）
    const c = reg.publish({ email: "a@example.com", manifest: manifest({ name: "已声明包", category: "legal", domain: ["risk"] }) });

    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(path.join(dir, "packs.db"));

    const catBefore = raw.prepare("SELECT id, category FROM packs ORDER BY id").all();

    const plan = planBackfill(raw);
    assert.equal(plan.planned.length, 1);
    assert.equal(plan.planned[0].id, a.id);
    assert.deepEqual(plan.planned[0].domains, ["legal"]);
    assert.equal(plan.alreadyDeclared.length, 1);
    assert.equal(plan.unclassified.length, 1);
    assert.equal(plan.unclassified[0].id, b.id);

    const written = applyBackfill(raw, plan);
    assert.equal(written, 1);

    assert.deepEqual(raw.prepare("SELECT id, category FROM packs ORDER BY id").all(), catBefore);
    assert.deepEqual(reg.get(a.id)?.domains, ["legal"]);
    assert.equal(reg.get(b.id)?.domains, undefined);
    assert.deepEqual(reg.get(c.id)?.domains, ["risk"]);

    // 回填后分面计数与服务端一致：A 的 legal 与 C 声明的 risk 各出现一次，
    // 顺序是词表顺序（risk 在 legal 之前），未归类的 B 不贡献任何领域。
    const f = reg.facets({});
    assert.deepEqual(f.domains.map((d) => [d.slug, d.count]), [["risk", 1], ["legal", 1]]);
    assert.equal(f.lines.find((l) => l.slug === "lex").count, 2);

    // 幂等：再跑一次不再计划任何行
    const again = planBackfill(raw);
    assert.equal(again.planned.length, 0);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
