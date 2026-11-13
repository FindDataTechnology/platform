// plaza-export gate tests (add-agent-materials-plaza v2): the six-lint, the
// annotation shape gate, the per-source count reconciliation gates, species
// pages, and the slug/address stability contract — driven on fixtures, no
// network.
//
// Run: node --test scripts/test-plaza-export.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admissionPredicate,
  annotatePack,
  annotateSkill,
  annotateMcp,
  annotateFacade,
  annotateDataAnchor,
  buildCatalog,
  buildInfrastructurePage,
  buildMaterialPages,
  lintAiReadable,
  lintAnnotationShape,
  materialSlug,
  speciesSlug,
  runExport,
} from "./plaza-export.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const genAt = "2026-11-03";
const mkPack = (id, over = {}) => ({
  id,
  name: `Pack ${id}`,
  description: `Material ${id}: a versioned bundle of skills, MCP references, and personas.`,
  category: "demo",
  featured: false,
  official: false,
  badge: null,
  ...over,
});

const mkFixture = () => {
  const packs = [
    mkPack("alpha-suite", { featured: true, official: true, manifest: { skills: [{ name: "alpha-skill", description: "bundled skill" }], mcpServers: [{ registryName: "eco-mcp-fetch" }] } }),
    mkPack("beta-facade", { badge: "facade", category: "company" }),
    mkPack("gamma-private", { category: null, featured: false }), // fails the predicate
  ];
  const listingsByLocale = Object.fromEntries(
    ["zh-CN", "en", "es", "fr", "ja"].map((l) => [
      l,
      l === "en" ? packs : packs.map((p) => ({ ...p, name: `${p.name} (${l})`, description: `${p.description} [${l}]` })),
    ]),
  );
  const skills = [
    { name: "contract-review", displayName: "contract-review", description: "中文合同审查:风险维度系统审查商事合同条款", tags: ["法律"], version: "1.0.0", repositoryUrl: null },
    { name: "financial-statement-analysis", description: "上市公司财报分析:三表联动+比率分析", tags: ["金融"] },
  ];
  const mcpZh = [
    { name: "eco-mcp-fetch", displayName: "eco-mcp-fetch", description: "Fetch content from any URL — no configuration needed", endpoint: "https://mcp.example/eco-mcp-fetch/mcp", requiredGroups: [],
      annotation: { name: "网页抓取（托管版）", summary: "托管在平台上的网页抓取：取回指定网址内容并转成可读文本。", whenToUse: "不想在本机装进程时。", source: "finddata-supply-annotations" } },
    { name: "fd-daas-mcp", displayName: "fd-daas-mcp", description: "FindData data MCP: macro and financial real sources", endpoint: "https://mcp.example/fd-daas-mcp/mcp", requiredGroups: [] },
  ];
  const mcpEn = mcpZh.map((s) => s.name === "eco-mcp-fetch"
    ? { ...s, annotation: { name: "Web fetch (hosted)", summary: "Hosted web fetch: retrieve a URL's content.", whenToUse: "When you want page content without installing anything.", source: "finddata-supply-annotations" } }
    : s);
  return {
    listingsByLocale,
    skills,
    mcpServers: mcpZh,
    mcpByLocale: { "zh-CN": mcpZh, en: mcpEn },
    mcpDepths: {
      "eco-mcp-fetch": { name: "eco-mcp-fetch", tools: [{ name: "fetch", description: "Fetches a URL" }], toolCount: 1, license: "MIT", providerOrganization: "modelcontextprotocol", tags: [] },
      "fd-daas-mcp": { name: "fd-daas-mcp", tools: [{ name: "macro_query", description: "Query macro series" }, { name: "stock_query", description: "Query stock series" }], toolCount: 2, license: null, providerOrganization: "FindData", tags: ["数据"] },
    },
    marketplaceCount: 2,
  };
};

const listFromFixture = (fx) => fx.listingsByLocale;

test("admission predicate mirrors loadListedPacks: public+non-unlisted+curated, whitelist replaces", () => {
  assert.equal(admissionPredicate(mkPack("a", { category: "x" })), true);
  assert.equal(admissionPredicate(mkPack("a", { featured: true })), true);
  assert.equal(admissionPredicate(mkPack("a", { category: null, featured: false })), false);
  assert.equal(admissionPredicate(mkPack("a", { category: null, featured: false }), ["a"]), true);
});

test("slug is species-namespaced and stable across content updates", () => {
  assert.equal(materialSlug("Alpha_Suite 2"), "pack-alpha-suite-2");
  assert.equal(speciesSlug("skill", "contract-review"), "skill-contract-review");
  assert.equal(speciesSlug("mcp", "eco-mcp-fetch"), "mcp-eco-mcp-fetch");
  // stability: the same species+id always maps to the same slug
  assert.equal(speciesSlug("skill", "x"), speciesSlug("skill", "x"));
  // no cross-registry collision: same id in different species → different pages
  assert.notEqual(speciesSlug("pack", "fetch"), speciesSlug("mcp", "fetch"));
});

test("skills annotate honestly: zh verbatim in all five slots, provenance names the skills source", () => {
  const fx = mkFixture();
  const m = annotateSkill(fx.skills[0], genAt, "fixture://skills-catalog");
  assert.equal(m.category, "skill");
  for (const l of ["zh-CN", "en", "es", "fr", "ja"]) {
    assert.equal(m.human[l].summary, fx.skills[0].description, `${l} carries the zh source verbatim (no fabricated translation)`);
  }
  assert.equal(m.provenance.source, "fixture://skills-catalog");
  assert.ok(m.whenToUse.includes("法律"), "tags inform whenToUse");
});

test("skill translations: en slot + canonical carry the curated translation, zh keeps source, missing falls back", () => {
  const fx = mkFixture();
  const tr = { en: "Contract review in Chinese: systematic risk review of commercial clauses.", es: "Revisión de contratos en chino: revisión sistemática de riesgos.", fr: "Relecture de contrats en chinois : revue systématique des risques.", ja: "中国語契約審査：商務契約条項の体系的リスクレビュー。" };
  const m = annotateSkill(fx.skills[0], genAt, "fixture://skills-catalog", tr);
  assert.equal(m.human["zh-CN"].summary, fx.skills[0].description, "zh keeps the registry source verbatim");
  assert.equal(m.human.en.summary, tr.en);
  assert.equal(m.human.es.summary, tr.es);
  assert.equal(m.human.fr.summary, tr.fr);
  assert.equal(m.human.ja.summary, tr.ja);
  assert.equal(m.canonical.brief, tr.en, "canonical rides the en translation");
  const noTr = annotateSkill(fx.skills[0], genAt, "fixture://skills-catalog", null);
  for (const l of ["en", "es", "fr", "ja"]) assert.equal(noTr.human[l].summary, fx.skills[0].description, "missing translation falls back to zh");
  assert.equal(noTr.canonical.brief, fx.skills[0].description);
});

test("MCP annotation projects per locale and the tool surface rides the entry", () => {
  const fx = mkFixture();
  const pick = (loc) => fx.mcpByLocale[loc].find((s) => s.name === "eco-mcp-fetch");
  const m = annotateMcp(
    Object.fromEntries(["zh-CN", "en"].map((l) => [l, pick(l)])),
    fx.mcpDepths["eco-mcp-fetch"],
    genAt,
    "fixture://mcp-catalog",
  );
  assert.equal(m.category, "mcp");
  assert.equal(m.human["zh-CN"].name, "网页抓取（托管版）");
  assert.equal(m.human.en.name, "Web fetch (hosted)");
  assert.equal(m.toolCount, 1);
  assert.equal(m.license, "MIT");
  assert.deepEqual(m.tools.map((t) => t.name), ["fetch"]);
  assert.ok(m.endpoint);
});

test("pack contents enumerate the manifest's own skills and MCP references", () => {
  const fx = mkFixture();
  const listings = listFromFixture(fx);
  for (const p of listings["zh-CN"]) {
    if (p.id === "alpha-suite") p.contents = { skills: [{ name: "alpha-skill", description: "bundled skill" }], mcpServers: [{ registryName: "eco-mcp-fetch" }] };
  }
  const materials = annotatePack(listings, genAt, "fixture://facet");
  const alpha = materials.find((m) => m.id === "alpha-suite");
  assert.deepEqual(alpha.contents.skills, [{ name: "alpha-skill", description: "bundled skill" }]);
  assert.deepEqual(alpha.contents.mcpServers, [{ registryName: "eco-mcp-fetch" }]);
});

test("annotation shape gate: complete entries pass, missing provenance/category red", () => {
  const fx = mkFixture();
  const materials = [
    ...annotatePack(listFromFixture(fx), genAt, "fixture://facet"),
    ...fx.skills.map((s) => annotateSkill(s, genAt, "fixture://skills-catalog")),
    ...fx.mcpServers.map((s) => annotateMcp({ "zh-CN": s }, fx.mcpDepths[s.name], genAt, "fixture://mcp-catalog")),
  ];
  assert.equal(materials.length, 6, "2 packs (predicate) + 2 skills + 2 mcp");
  assert.deepEqual(lintAnnotationShape(materials), [], "complete entries pass G2");
  const broken = structuredClone(materials);
  delete broken[0].provenance.updatedAt;
  assert.ok(lintAnnotationShape(broken).some((v) => v.includes("provenance")), "G2 catches missing provenance");
  broken[0].provenance = { source: "x", updatedAt: genAt };
  broken[0].category = "fleet";
  assert.ok(lintAnnotationShape(broken).some((v) => v.includes("closed enum")), "G2 catches enum escape");
});

test("ai_readable lint: cold-read applies to ALL species pages, table on infrastructure", () => {
  const fx = mkFixture();
  const materials = [
    ...annotatePack(listFromFixture(fx), genAt, "fixture://facet"),
    ...fx.skills.map((s) => annotateSkill(s, genAt, "fixture://skills-catalog")),
    ...fx.mcpServers.map((s) => annotateMcp({ "zh-CN": s }, fx.mcpDepths[s.name], genAt, "fixture://mcp-catalog")),
  ];
  const pages = [...buildMaterialPages(materials, "https://x", genAt), buildInfrastructurePage(genAt, "https://x")];
  assert.deepEqual(lintAiReadable(pages), [], "well-formed pages of every species pass G3");
  const bad = structuredClone(pages);
  bad.find((p) => p.name.includes("skill-")).content = bad.find((p) => p.name.includes("skill-")).content.replace(/## How to obtain/, "## Usage");
  assert.ok(lintAiReadable(bad).some((v) => v.includes("cold-read")), "skill page without obtain section red");
});

test("species pages embed their specifics: mcp tools, skill obtain, pack contents", () => {
  const fx = mkFixture();
  const materials = [
    ...annotatePack(listFromFixture(fx), genAt, "fixture://facet"),
    ...fx.skills.map((s) => annotateSkill(s, genAt, "fixture://skills-catalog")),
    ...fx.mcpServers.map((s) => annotateMcp({ "zh-CN": s }, fx.mcpDepths[s.name], genAt, "fixture://mcp-catalog")),
  ];
  const pages = buildMaterialPages(materials, "https://x", genAt);
  const mcpPage = pages.find((p) => p.name.includes("mcp-eco-mcp-fetch"));
  assert.ok(mcpPage.content.includes("fetch"), "tool name on the page");
  assert.ok(/Public tools: 1/.test(mcpPage.content), "toolCount on the page");
  assert.ok(mcpPage.content.includes("Extensions → MCP"), "mcp obtain = connect path");
  const skillPage = pages.find((p) => p.name.includes("skill-contract-review"));
  assert.ok(skillPage.content.includes("Extensions → Skills"), "skill obtain = extensions face");
  const packPage = pages.find((p) => p.name.includes("pack-alpha-suite"));
  assert.ok(packPage.content.includes("## What it contains"), "pack page enumerates contents");
  assert.ok(packPage.content.includes("alpha-skill"), "bundled skill named");
  assert.ok(packPage.content.includes("eco-mcp-fetch"), "mcp reference named");
});

test("count reconciliation gate: any species mismatch red, zero artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-export-"));
  const fixture = path.join(dir, "fixture.json");
  const fx = mkFixture();
  fx.skills = [...fx.skills, { description: "malformed registry entry without a name — annotator skips it, G1 must see the drop", tags: [] }];
  fs.writeFileSync(fixture, JSON.stringify(fx));
  await assert.rejects(
    () => runExport({ fixture, outDir: path.join(dir, "gen") }),
    (err) => err.message.includes("G1 skills"),
  );
  assert.equal(fs.existsSync(path.join(dir, "gen", "catalog.json")), false, "zero artifacts on red");
});

test("full export on green fixture writes all artifact kinds with three species", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-export-"));
  const fixture = path.join(dir, "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify(mkFixture()));
  const r = await runExport({ fixture, outDir: path.join(dir, "gen") });
  assert.deepEqual(r.counts, { packs: 2, skills: 2, mcpServers: 2, facades: 0, officialData: 0, tools: 3 });
  for (const f of ["snapshot.json", "catalog.json", "llms.txt", "llms-full.txt", "infrastructure.md", "counts.json", "skills-snapshot.json"]) {
    assert.ok(fs.existsSync(path.join(dir, "gen", f)), `${f} written`);
  }
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "skill-contract-review.md")));
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "mcp-eco-mcp-fetch.md")));
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "gen", "catalog.json"), "utf8"));
  assert.equal(cat.schema, "yizuo-agent-materials-plaza/catalog@2");
  assert.equal(cat.count, 6);
  const llms = fs.readFileSync(path.join(dir, "gen", "llms.txt"), "utf8");
  assert.ok(llms.includes("## Skills (2)"), "skills section in the index");
  assert.ok(llms.includes("## MCP servers (2 — 3 public tools embedded per page)"), "mcp section with tool total");
});

// ── machine surfaces speak per-species counts (fix-supply-machine-faces 3.x) ─
//
// 机器面上的计数必须按物种逐项报，且 llms.txt 与 catalog.json 同一口径、
// 同一生成时间。跨物种合称（旧头的「577 agents = pack+facade+official-data」）
// 一律不许再出现——AI 客户端按那个数字对账会永远对不上。
test("llms.txt reports every species separately and no merged total", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-counts-"));
  const fixture = path.join(dir, "fixture.json");
  const fx = mkFixture();
  fx.facades = [mkFacade("law-assistant")];
  fx.dataAnchors = [mkAnchor("gdp")];
  fs.writeFileSync(fixture, JSON.stringify(fx));

  const r = await runExport({ fixture, outDir: path.join(dir, "gen") });
  const llms = fs.readFileSync(path.join(dir, "gen", "llms.txt"), "utf8");
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "gen", "catalog.json"), "utf8"));

  // 五物种各报各的
  assert.ok(llms.includes(`${r.counts.packs} packs`), "pack count named");
  assert.ok(llms.includes(`${r.counts.skills} skills`), "skill count named");
  assert.ok(llms.includes(`${r.counts.mcpServers} MCP servers`), "mcp count named");
  assert.ok(llms.includes(`${r.counts.facades} facades`), "facade count named");
  assert.ok(llms.includes(`${r.counts.officialData} official data anchors`), "official-data count named");

  // 不许出现跨物种合称
  assert.equal(/\b\d+ agents\b/.test(llms), false, "no merged 'agents' total on the machine surface");
  assert.equal(llms.includes("## Agents ("), false, "no merged Agents section");

  // catalog 的 per-species 计数与 llms 同源
  const byCat = cat.materials.reduce((a, m) => { a[m.category] = (a[m.category] ?? 0) + 1; return a; }, {});
  assert.equal(cat.counts.packs, byCat.pack ?? 0);
  assert.equal(cat.counts.skills, byCat.skill ?? 0);
  assert.equal(cat.counts.mcpServers, byCat.mcp ?? 0);
  assert.equal(cat.counts.facades, byCat.facade ?? 0);
  assert.equal(cat.counts.officialData, byCat["official-data"] ?? 0);

  // 同一生成时间：机器面两处逐字节相等
  const stamp = cat.generatedAt;
  assert.ok(stamp, "catalog carries generatedAt");
  assert.ok(llms.includes(`As of: ${stamp}`), "llms.txt carries the same generation timestamp");

  // 机器面自指的地址是根路径（发布脚本把三份导出物拷到站点根）
  assert.ok(llms.includes("/catalog.json"), "catalog link uses the root path");
});

// ── five species (add-supply-catalog-unification): facade + data-anchor ─────

const mkFacade = (id, over = {}) => ({
  id,
  name: `Facade ${id}`,
  description: `A deployed agent service ${id}.`,
  status: "unknown",
  deployment: null,
  tags: [],
  annotation: {
    canonical: { brief: `A deployed agent service ${id}.` },
    human: { zh: { name: `分身 ${id}`, summary: `已部署的智能体服务 ${id}。` }, en: { name: `Facade ${id}`, summary: `A deployed agent service ${id}.` }, ja: { name: `分身 ${id}`, summary: `已部署的智能体服务 ${id}。` }, es: { name: `分身 ${id}`, summary: `已部署的智能体服务 ${id}。` }, fr: { name: `分身 ${id}`, summary: `已部署的智能体服务 ${id}。` } },
    whenToUse: "Talk to a running service.",
    provenance: { source: "wanxing-facade", updatedAt: genAt },
  },
  ...over,
});

const mkAnchor = (id, over = {}) => ({
  id,
  name: `Indicator ${id}`,
  kind: "indicator",
  summary: `GDP series ${id}`,
  source: "nbs",
  annotation: {
    canonical: { brief: `GDP series ${id}` },
    human: { zh: { name: `指标 ${id}`, summary: `GDP 序列 ${id}` }, en: { name: `Indicator ${id}`, summary: `GDP series ${id}` }, ja: { name: `指标 ${id}`, summary: `GDP 序列 ${id}` }, es: { name: `指标 ${id}`, summary: `GDP 序列 ${id}` }, fr: { name: `指标 ${id}`, summary: `GDP 序列 ${id}` } },
    whenToUse: "Reference a macro indicator.",
    provenance: { source: "daas-catalog", updatedAt: genAt },
  },
  ...over,
});

test("badge-derived pack is no longer a facade species (category stays pack)", () => {
  const fx = mkFixture();
  const packs = annotatePack(listFromFixture(fx), genAt, "fixture://facet");
  const beta = packs.find((p) => p.id === "beta-facade");
  assert.equal(beta.category, "pack", "facade badge no longer derives the species");
  assert.equal(beta.badges.facade, true, "the display badge still rides the pack");
});

test("facade annotator: honest unknown status, deployment provenance, lint-clean", () => {
  const m = annotateFacade(mkFacade("law-assistant", { status: "running", deployment: { packId: "law-bench", agentId: "assistant", deployedAt: 1 } }), genAt, "fixture://facades-catalog");
  assert.equal(m.category, "facade");
  assert.equal(m.status, "running");
  assert.equal(m.deployment.packId, "law-bench");
  assert.equal(m.provenance.source, "wanxing-facade");
  assert.deepEqual(lintAnnotationShape([m]), []);
  // status absent → explicit unknown, never a defaulted healthy
  const noStatus = annotateFacade({ id: "x", name: "X", description: "d" }, genAt, "fixture://facades-catalog");
  assert.equal(noStatus.status, "unknown");
});

test("data-anchor annotator: DAAS provenance, lint-clean", () => {
  const m = annotateDataAnchor(mkAnchor("gdp"), genAt, "fixture://data-anchors-catalog");
  assert.equal(m.category, "official-data");
  assert.equal(m.provenance.source, "daas-catalog");
  assert.equal(m.anchorKind, "indicator");
  assert.deepEqual(lintAnnotationShape([m]), []);
});

// Curation evidence must survive the LAST hop — the public catalog json. The
// serving faces compute it (facet/supply-catalog.attachEvidenceSummary) and the
// plaza export projects materials field-by-field, so a whitelist that forgets it
// silently drops the whole dimension between the API and the market.
test("curation evidence reaches the exported material, projected (no reviewer)", () => {
  const withEvidence = annotateFacade(
    mkFacade("law-assistant", {
      evidence: { state: "complete", licence: "MIT-0", reviewValidUntil: "2027-11-01", reviewedBy: "ops@acme", reasons: ["internal"] },
    }),
    genAt,
    "fixture://facades-catalog",
  );
  assert.deepEqual(withEvidence.evidence, { state: "complete", licence: "MIT-0", reviewValidUntil: "2027-11-01" });
  assert.equal(JSON.stringify(withEvidence).includes("ops@acme"), false, "a public json never carries the reviewer");

  // A material with no evidence carries NO key — not an invented state.
  const bare = annotateFacade(mkFacade("plain"), genAt, "fixture://facades-catalog");
  assert.equal("evidence" in bare, false);

  // …and the catalog projection keeps what the annotator produced.
  const cat = buildCatalog([withEvidence, bare, annotateDataAnchor(mkAnchor("gdp"), genAt, "fixture://data-anchors-catalog")]);
  const facade = cat.materials.find((m) => m.category === "facade" && m.evidence);
  assert.deepEqual(facade.evidence, { state: "complete", licence: "MIT-0", reviewValidUntil: "2027-11-01" });
  assert.equal(cat.materials.filter((m) => "evidence" in m).length, 1, "only the reviewed material carries the key");
});

test("full export spans five species with counts and material pages", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-five-"));
  const fixture = path.join(dir, "fixture.json");
  const fx = mkFixture();
  fx.facades = [mkFacade("law-assistant"), mkFacade("data-bot", { status: "paused" })];
  fx.dataAnchors = [mkAnchor("gdp"), mkAnchor("cpi"), mkAnchor("cn-region-bj", { kind: "entity", name: "CN11", source: "1" })];
  fs.writeFileSync(fixture, JSON.stringify(fx));
  const r = await runExport({ fixture, outDir: path.join(dir, "gen") });
  // 真实口径（五物种各归各类）：packs 只数 pack——部署类物种不再并入
  // （counts.packs 与 byCategory.pack 必须同值，消费方对账锚点）。
  assert.equal(r.counts.packs, 2); // 2 packs（facade 2 + anchors 3 各归各类）
  assert.equal(r.counts.skills, 2);
  assert.equal(r.counts.mcpServers, 2);
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "gen", "catalog.json"), "utf8"));
  assert.equal(cat.count, 2 + 2 + 2 + 2 + 3);
  const byCat = cat.materials.reduce((a, m) => { a[m.category] = (a[m.category] ?? 0) + 1; return a; }, {});
  assert.equal(byCat.facade, 2);
  assert.equal(byCat["official-data"], 3);
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "facade-law-assistant.md")));
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "official-data-gdp.md")));
  const page = fs.readFileSync(path.join(dir, "gen", "materials", "facade-data-bot.md"), "utf8");
  assert.ok(page.includes("Live status (serving plane): paused"), "facade page states status");
});

test("G1 facade count mismatch fails the build with zero artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-g1facade-"));
  const fixture = path.join(dir, "fixture.json");
  const fx = mkFixture();
  fx.facades = [mkFacade("law-assistant"), { name: "no-id", description: "missing id — annotator drops it, G1 sees the mismatch" }];
  fs.writeFileSync(fixture, JSON.stringify(fx));
  await assert.rejects(
    () => runExport({ fixture, outDir: path.join(dir, "gen") }),
    (err) => err.message.includes("G1 facades"),
  );
  assert.equal(fs.existsSync(path.join(dir, "gen", "catalog.json")), false);
});
