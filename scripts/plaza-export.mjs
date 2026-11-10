// ── 壹座·智能体素材广场 export pipeline (add-agent-materials-plaza, v2) ──
//
// v2 (2026-11-03): the inventory spans the THREE material species, each
// ingested from its own registry public face — packs from the market listing,
// skills from /api/skills-catalog, MCP servers from /api/mcp-catalog (with the
// per-server depth carrying the full public tool surface). Per-source count
// reconciliation: packs against the production single-rule endpoint
// /api/marketplace/marketplace.json, skills/mcp against their own source
// arrays (set equality catches mapping drops).
//
// Surfaces written: snapshot.json (packs fallback face), catalog.json
// (annotation-layer shape), llms.txt / llms-full.txt, materials/*.md
// (species-aware self-contained pages), infrastructure.md, counts.json
// (hero: three species counts + tools).
//
// Gates (fail = non-zero exit, zero artifacts written):
//   G1 count reconciliation  — per source, as above
//   G2 annotation shape      — canonical.brief, human.{5 slots}, whenToUse,
//                              provenance{source,updatedAt} on EVERY entry
//   G3 ai_readable six lint  — self-contained / entity named / one term per
//                              concept / input–action–output table / cold-read
//                              three questions / provenance present
//
// Run:  node scripts/plaza-export.mjs [--base <facet-url>] [--out <dir>] [--fixture <file>]
//       [--allow-stale]   # on total fetch failure, continue from the last snapshot
//
// Offline/test: --fixture <file> (see scripts/test-plaza-export.mjs for shape).

import fs from "node:fs";
import path from "node:path";

const PLAZA_NAME = {
  zh: "壹座·智能体素材广场",
  en: "Yizuo Agent Materials Plaza",
};
const LOCALES = ["zh-CN", "en", "es", "fr", "ja"];
const DEFAULT_BASE = process.env.FACET_BASE || "https://facet.finddatatech.cloud";
const CATEGORY_ENUM_VERSION = 1;
// The closed category enumeration (agent-materials-plaza spec: new species
// extend this with a version bump, never overload an existing value).
const CATEGORY_ENUM = ["pack", "skill", "mcp", "facade", "official-data"];
const SKILLS_PAGE_SIZE = 500;

// ── admission predicate — mirror of facet/marketplace-json.js loadListedPacks ──
export function admissionPredicate(pack, whitelist = []) {
  if (whitelist.length > 0) return whitelist.includes(pack.id);
  return Boolean(pack.category || pack.featured);
}

// ── fetch with bounded retry (design risk: anonymous facet read may 429) ──
async function fetchJson(url, { tries = 3, backoffMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
    }
  }
  throw lastErr;
}

// Paginate the anonymous browse face for one locale. The viewer-less listing
// already answers public packs only (pack-visibility posture); unlisted packs
// are absent from the browse face, so the curated predicate is the only
// narrowing this side adds — byte-parallel to loadListedPacks.
export async function fetchListedForLocale(base, locale, { fetchImpl = fetchJson } = {}) {
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const body = await fetchImpl(`${base}/api/packs?page=${page}&pageSize=100&locale=${locale}`);
    const packs = body?.packs ?? [];
    out.push(...packs);
    const total = Number(body?.total ?? 0);
    if (out.length >= total || packs.length === 0) break;
  }
  return out;
}

// ── slug: species-namespaced stable addresses (v2: three registries never collide) ──
export function materialSlug(packId) {
  return speciesSlug("pack", packId);
}
export function speciesSlug(species, id) {
  const s = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${species}-${s}`;
}

// ── merge per-locale pack listings into annotated materials ──
export function annotatePack(listingsByLocale, generatedAt, source) {
  const ids = new Set();
  for (const packs of Object.values(listingsByLocale)) {
    for (const p of packs) if (admissionPredicate(p)) ids.add(p.id);
  }
  const materials = [];
  for (const id of ids) {
    const byLocale = {};
    let anchor = null;
    for (const locale of LOCALES) {
      const p = (listingsByLocale[locale] ?? []).find((x) => x.id === id && admissionPredicate(x));
      if (!p) continue;
      byLocale[locale] = {
        name: p.name ?? id,
        summary: p.description ?? "",
        whenToUse: p.category ? `Browse under "${p.category}" in the market.` : undefined,
      };
      if (!anchor) anchor = p;
    }
    if (!anchor) continue;
    // zh/en are the AI-surface canon pair; a missing es/fr/ja track falls back
    // to en (never to silence).
    if (!byLocale.en && byLocale["zh-CN"]) byLocale.en = { ...byLocale["zh-CN"] };
    if (!byLocale["zh-CN"] && byLocale.en) byLocale["zh-CN"] = { ...byLocale.en };
    for (const l of ["es", "fr", "ja"]) {
      if (!byLocale[l] && byLocale.en) byLocale[l] = { ...byLocale.en };
    }
    const zh = byLocale["zh-CN"] ?? byLocale.en;
    // pack-internal contents (v2): the manifest's own skills + MCP references.
    // Network path: fetchPackContents stamps anchor.contents from the detail
    // face. Fixture path: the raw listing may carry manifest directly — same
    // derivation, one code path.
    const contents = anchor.contents ?? (anchor.manifest
      ? {
          skills: (anchor.manifest.skills ?? []).map((x) => ({ name: x.name, description: x.description ?? "" })),
          mcpServers: (anchor.manifest.mcpServers ?? []).map((x) => ({ registryName: x.registryName ?? x.name ?? String(x) })),
        }
      : null);
    materials.push({
      id,
      slug: speciesSlug("pack", id),
      category: mapCategory(anchor),
      marketCategory: anchor.category ?? null,
      tags: Array.isArray(anchor.tags) ? anchor.tags.slice(0, 8) : [],
      contents,
      canonical: { brief: (byLocale.en?.summary || zh.summary || "").slice(0, 300) },
      human: {
        "zh-CN": { name: zh.name, summary: zh.summary },
        en: { name: byLocale.en?.name ?? zh.name, summary: byLocale.en?.summary ?? zh.summary },
        es: { name: byLocale.es?.name ?? byLocale.en?.name ?? zh.name, summary: byLocale.es?.summary ?? byLocale.en?.summary ?? "" },
        fr: { name: byLocale.fr?.name ?? byLocale.en?.name ?? zh.name, summary: byLocale.fr?.summary ?? byLocale.en?.summary ?? "" },
        ja: { name: byLocale.ja?.name ?? byLocale.en?.name ?? zh.name, summary: byLocale.ja?.summary ?? byLocale.en?.summary ?? "" },
      },
      whenToUse: byLocale.en?.whenToUse ?? zh.summary?.slice(0, 120) ?? "",
      badges: {
        official: Boolean(anchor.official),
        // Display-only: a pack may be facade-CAPABLE. The facade SPECIES is no
        // longer derived here — it comes from the deployments public face
        // (add-supply-catalog-unification: badge-derived species retired).
        facade: anchor.badge === "facade" || anchor.badge === "assistant",
      },
      provenance: { source, updatedAt: generatedAt },
    });
  }
  return materials;
}

// Packs are packs: the facade / official-data categories are NO LONGER derived
// from pack badges or name heuristics (add-supply-catalog-unification). Those
// species admit through their own source faces (annotateFacade / annotateDataAnchor).
function mapCategory(_pack) {
  return "pack";
}

// ── facade species — admitted by the serving plane's own public face ─────────
// Entries come from facet /api/facades-catalog, which projects the deployments
// public face (万星's own admission rule). The annotation shape is carried from
// the catalog (zh-fallback synthesized when unannotated); live status is the
// serving plane's report or an explicit "unknown" — never a defaulted healthy.
export function annotateFacade(f, generatedAt, source) {
  if (!f?.id) return null; // malformed — the G1 count gate must see the drop
  const name = f.name || f.id;
  const summary = f.description ?? "";
  const human5 = f.annotation?.human ?? {};
  const slot = (l) => {
    const src = human5[l === "zh-CN" ? "zh" : l] ?? human5.zh ?? {};
    return { name: src.name ?? name, summary: src.summary ?? summary };
  };
  return {
    id: `facade:${f.id}`,
    slug: speciesSlug("facade", f.id),
    category: "facade",
    marketCategory: null,
    tags: Array.isArray(f.tags) ? f.tags.slice(0, 8) : [],
    status: f.status ?? "unknown",
    deployment: f.deployment ?? null,
    canonical: { brief: (f.annotation?.canonical?.brief ?? summary).slice(0, 300) },
    human: Object.fromEntries(LOCALES.map((l) => [l, slot(l)])),
    whenToUse: f.annotation?.whenToUse ?? summary.slice(0, 120) ?? "A deployed agent service.",
    badges: { official: false, facade: true },
    provenance: {
      source: f.annotation?.provenance?.source ?? source,
      updatedAt: f.annotation?.provenance?.updatedAt ?? generatedAt,
    },
  };
}

// ── data-anchor species — admitted by the DAAS catalog face ──────────────────
export function annotateDataAnchor(a, generatedAt, _source) {
  if (!a?.id) return null; // malformed — the G1 count gate must see the drop
  const name = a.name || a.id;
  const summary = a.summary ?? "";
  const human5 = a.annotation?.human ?? {};
  const slot = (l) => {
    const src = human5[l === "zh-CN" ? "zh" : l] ?? human5.zh ?? {};
    return { name: src.name ?? name, summary: src.summary ?? summary };
  };
  return {
    id: `anchor:${a.id}`,
    slug: speciesSlug("official-data", a.id),
    category: "official-data",
    marketCategory: null,
    tags: [],
    anchorKind: a.kind ?? null,
    anchorSource: a.source ?? null,
    canonical: { brief: (a.annotation?.canonical?.brief ?? summary).slice(0, 300) },
    human: Object.fromEntries(LOCALES.map((l) => [l, slot(l)])),
    whenToUse: a.annotation?.whenToUse ?? summary.slice(0, 120) ?? "An official data reference point.",
    badges: { official: true, facade: false },
    provenance: {
      source: a.annotation?.provenance?.source ?? "daas-catalog",
      updatedAt: a.annotation?.provenance?.updatedAt ?? generatedAt,
    },
  };
}

// ── v2: skills species — registry visibility rule already applied upstream
// (no-required-groups = public on the anonymous face); zh source text is
// carried verbatim in all five locale slots (provenance stays honest; the
// translation pass is a recorded follow-up, never fabricated here). ──
export function annotateSkill(skill, generatedAt, source, tr = null) {
  if (!skill?.name) return null; // malformed registry entry — the G1 count gate must see the drop
  const name = skill.displayName || skill.name;
  const summary = skill.description ?? "";
  const tags = Array.isArray(skill.tags) ? skill.tags : [];
  // tr = curated translations of the summary ({en,es,fr,ja} — name/tags never
  // translated). zh keeps the registry source verbatim; untranslated slots fall
  // back to it rather than going silent. canonical rides the en translation
  // when present (the AI-surface canon language, matching the pack entries).
  const localized = (l) => (l === "zh-CN" ? summary : (tr?.[l] ?? summary));
  return {
    id: `skill:${skill.name}`,
    slug: speciesSlug("skill", skill.name),
    category: "skill",
    marketCategory: null,
    tags: tags.slice(0, 8),
    repositoryUrl: skill.repositoryUrl ?? null,
    canonical: { brief: (tr?.en ?? summary).slice(0, 300) },
    human: Object.fromEntries(
      LOCALES.map((l) => [l, { name, summary: localized(l) }]),
    ),
    whenToUse: tags.length ? `Relevant when working on: ${tags.join(", ")}.` : summary.slice(0, 120),
    badges: { official: false, facade: false },
    provenance: { source, updatedAt: generatedAt },
  };
}

// ── v2: MCP species — the annotation layer projects per locale natively;
// the depth route supplies the full public tool surface. ──
export function annotateMcp(listByLocale, depth, generatedAt, source) {
  // Identity = the registry's STABLE `name` field (displayName is cosmetic and
  // may be absent or localized — three production servers carry no displayName,
  // which the G1 gate caught as a mapping drop). Localized names live only in
  // the human slots.
  const name = listByLocale["zh-CN"]?.name ?? listByLocale.en?.name ?? depth?.name ?? listByLocale["zh-CN"]?.displayName ?? "unknown";
  if (!name || name === "unknown") return null; // malformed entry — G1 must see the drop
  const tools = depth?.tools ?? [];
  const zh = listByLocale["zh-CN"] ?? {};
  const canonSrc = zh.description ?? listByLocale.en?.description ?? "";
  return {
    id: `mcp:${name}`,
    slug: speciesSlug("mcp", name),
    category: "mcp",
    marketCategory: null,
    tags: Array.isArray(depth?.tags) ? depth.tags.slice(0, 8) : [],
    endpoint: listByLocale["zh-CN"]?.endpoint ?? listByLocale.en?.endpoint ?? depth?.endpoint ?? null,
    toolCount: depth?.toolCount ?? tools.length,
    license: depth?.license ?? null,
    provider: depth?.providerOrganization ?? null,
    canonical: { brief: canonSrc.slice(0, 300) },
    human: Object.fromEntries(
      LOCALES.map((l) => {
        const e = listByLocale[l] ?? {};
        const a = e.annotation;
        return [l, {
          name: a?.name ?? e.displayName ?? name,
          summary: a?.summary ?? e.description ?? canonSrc,
          whenToUse: a?.whenToUse,
        }];
      }),
    ),
    whenToUse: listByLocale["zh-CN"]?.annotation?.whenToUse ?? listByLocale.en?.annotation?.whenToUse ?? canonSrc.slice(0, 120),
    badges: { official: false, facade: false },
    tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
    provenance: { source, updatedAt: generatedAt },
  };
}

// ── G2: annotation shape gate (every species, every slot) ──
export function lintAnnotationShape(materials) {
  const violations = [];
  for (const m of materials) {
    if (!m.canonical?.brief) violations.push(`${m.id}: canonical.brief missing`);
    if (!m.whenToUse) violations.push(`${m.id}: whenToUse missing`);
    if (!m.provenance?.source || !m.provenance?.updatedAt) violations.push(`${m.id}: provenance incomplete`);
    for (const l of LOCALES) {
      if (!m.human?.[l]?.name) violations.push(`${m.id}: human.${l}.name missing`);
    }
    if (!CATEGORY_ENUM.includes(m.category)) violations.push(`${m.id}: category ${m.category} outside the closed enum`);
  }
  return violations;
}

// ── G3: ai_readable six lint (generated text artifacts) ──
const LINT_RULES = {
  selfContained: [/\bsee (?:above|below|the (?:previous|next) (?:section|chapter))\b/i, /见(?:上|下)(?:文|节|一节)/, /前述|上記のとおり/],
  entityNamed: [/(?:^|[^·])我们的平台(?![a-zA-Z·])/, /\bour platform\b/i],
  termUnique: [/素材(?:库|集)/],
  coldRead: [], // structural: enforced by the material-page builder contract below
  provenance: [], // structural: enforced via lintAnnotationShape (G2)
  table: [], // structural: infrastructure.md must contain the input–action–output table
};
export function lintAiReadable(pages) {
  const violations = [];
  for (const page of pages) {
    for (const [rule, patterns] of Object.entries(LINT_RULES)) {
      if (rule === "coldRead") {
        if (page.name.startsWith("materials/")) {
          const ok =
            /## What this is/.test(page.content) &&
            /## How to obtain/.test(page.content) &&
            /As of: 20\d\d-\d\d-\d\d/.test(page.content);
          if (!ok) violations.push(`${page.name}: cold-read three questions not structurally answerable`);
        }
        continue;
      }
      if (rule === "provenance") continue;
      if (rule === "table") {
        if (page.name === "infrastructure.md" && !/\| Action \|/.test(page.content)) {
          violations.push(`${page.name}: missing the input–action–output table`);
        }
        continue;
      }
      for (const re of patterns) {
        const m = re.exec(page.content);
        if (m) violations.push(`${page.name}: ${rule} violated → "${page.content.slice(Math.max(0, m.index - 15), m.index + 25)}"`);
      }
    }
  }
  return violations;
}

// ── generators ──
export function buildCatalog(materials) {
  return {
    schema: "yizuo-agent-materials-plaza/catalog@2",
    categoryEnumVersion: CATEGORY_ENUM_VERSION,
    categories: CATEGORY_ENUM,
    generatedAt: materials[0]?.provenance.updatedAt ?? null,
    count: materials.length,
    counts: {
      // 真实口径（五物种各归各类）：packs 只数 pack；facade/official-data
      // 自成物种——早前"部署类并包"的 577 口径会让 counts.packs 与
      // byCategory.pack 漂移两倍以上，消费方对不上账。
      packs: materials.filter((m) => m.category === "pack").length,
      skills: materials.filter((m) => m.category === "skill").length,
      mcpServers: materials.filter((m) => m.category === "mcp").length,
      // facade / official-data 也是物种，机器面上必须各报各的——
      // 合成一个「agents」总数就是这次要拆掉的口径（fix-supply-machine-faces 3.1）。
      facades: materials.filter((m) => m.category === "facade").length,
      officialData: materials.filter((m) => m.category === "official-data").length,
      tools: materials.reduce((n, m) => n + (m.toolCount ?? 0), 0),
    },
    materials: materials.map(({ id, slug, category, marketCategory, tags, contents, canonical, human, whenToUse, badges, tools, toolCount, license, provider, endpoint, repositoryUrl, provenance }) => {
      const entry = { id, slug, category, marketCategory, tags, canonical, human, whenToUse, badges, provenance };
      if (contents) entry.contents = contents;
      if (category === "mcp") Object.assign(entry, { tools, toolCount, license, provider, endpoint });
      if (category === "skill" && repositoryUrl) entry.repositoryUrl = repositoryUrl;
      return entry;
    }),
  };
}

// species-aware obtain paths (honest, no invention):
//   pack  → market subscribe / CLI / 壹座 in-product market
//   skill → 壹座 extensions skills face + bundled-by packs (+ repositoryUrl when present)
//   mcp   → connect the endpoint (壹座 MCP config / editors) — servers are
//           connected, not installed
function obtainSection(m, base) {
  if (m.category === "mcp") {
    return `## How to obtain

MCP servers are connected, not installed. The public endpoint:

    ${m.endpoint ?? `${base}/mcp (see the catalog)`}

Connect it where your agent runs: in 壹座 (Extensions → MCP), or in any MCP-capable editor's config. The endpoint speaks the Model Context Protocol over streamable HTTP.
`;
  }
  if (m.category === "skill") {
    const repo = m.repositoryUrl ? `\nSource repository: ${m.repositoryUrl}\n` : "";
    return `## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.${repo}
`;
  }
  if (m.category === "facade") {
    return `## How to obtain

A facade is a deployed agent service — it is reached, not installed. Its public
page and A2A endpoint are served by 万星 (Wanxing); live status as reported by the
serving plane: **${m.status ?? "unknown"}**.

${m.deployment?.packId ? `Deployed from pack \`${m.deployment.packId}\` (agent \`${m.deployment.agentId}\`).\n` : ""}
Talk to it through its share page, or call it agent-to-agent through the A2A face.
`;
  }
  if (m.category === "official-data") {
    return `## How to obtain

An official data anchor is a reference point consumed through the data plane, not
installed. ${m.anchorSource ? `Native source: \`${m.anchorSource}\`. ` : ""}It reaches agents through the DAAS / business supply surface (the same catalog this entry's provenance names).
`;
  }
  const obtainCli = `npx @finddatatechnology/facet install ${m.id.replace("pack:", "")}`;
  const marketUrl = `${base}/#/packs`;
  return `## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "${m.human.en.name}", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       ${obtainCli}

3. From the market page: ${marketUrl}
`;
}

function contentsSection(m) {
  if (m.category !== "pack" || !m.contents) return "";
  const skills = m.contents.skills ?? [];
  const mcps = m.contents.mcpServers ?? [];
  if (skills.length === 0 && mcps.length === 0) return "";
  const lines = ["", "## What it contains", ""];
  if (skills.length) {
    lines.push(`Skills (${skills.length}):`);
    for (const s of skills) lines.push(`- ${s.name}${s.description ? ` — ${String(s.description).slice(0, 120)}` : ""}`);
  }
  if (mcps.length) {
    lines.push("", `MCP server references (${mcps.length}): ${mcps.map((x) => x.registryName ?? x).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildMaterialPages(materials, base, _generatedAt) {
  const pages = [];
  for (const m of materials) {
    const title = m.human.en.name && m.human.en.name !== m.human["zh-CN"].name
      ? `# ${m.human.en.name} / ${m.human["zh-CN"].name}`
      : `# ${m.human["zh-CN"].name}`;
    const enSummary = m.human.en.summary && m.human.en.summary !== m.human["zh-CN"].summary ? m.human.en.summary : null;
    const body = `${title}

## What this is

${m.human["zh-CN"].summary || m.canonical.brief}
${enSummary ? `\n${enSummary}\n` : ""}
- Species: ${m.category} (plaza category enum v${CATEGORY_ENUM_VERSION})
- Official: ${m.badges.official ? "yes — curated by FindData" : "no"}
${m.category === "mcp" ? `- Public tools: ${m.toolCount}${m.license ? ` · License: ${m.license}` : ""}${m.provider ? ` · Provider: ${m.provider}` : ""}` : ""}
${m.category === "facade" ? `- Live status (serving plane): ${m.status ?? "unknown"}${m.deployment?.packId ? ` · deployed from \`${m.deployment.packId}\`` : ""}` : ""}
${m.category === "official-data" ? `- Anchor kind: ${m.anchorKind ?? "catalog"}${m.anchorSource ? ` · native source: \`${m.anchorSource}\`` : ""}` : ""}
${obtainSection(m, base)}${contentsSection(m)}
## As of

Provenance: ${m.provenance.source} · As of: ${m.provenance.updatedAt}
`;
    pages.push({ name: `materials/${m.slug}.md`, content: body, material: m });
  }
  return pages;
}

export function buildInfrastructurePage(generatedAt, base) {
  const zh = `# 壹座·智能体素材广场 —— 基础设施说明（zh 镜像见文末）

壹座·智能体素材广场（Yizuo Agent Materials Plaza）是面向人与 AI 的素材总览面。它呈现三件事：平台提供了哪些素材、这些素材如何被供给、此刻有哪些素材在场。

## 供给机制（输入-动作-产出）

| Action | Input | Output | Guarantee |
| ------ | ----- | ------ | --------- |
| 发布 Publish | 功能集 manifest（技能+MCP 引用+角色） | 市场上的一个不可变版本快照 | 版本一经发布不可改写；下架不毁已装快照 |
| 获取 Obtain | 五编辑器 CLI / 壹座内置市场 / 谦面市场页 | 装进运行环境的一份冻结快照 | 安装逐包显式发生；匿名可浏览 |
| 运行 Run | 已装快照 + 用户单元（cell） | 隔离运行中的角色与工具面 | cell 间互不可见；工具白名单收窄上下文 |
| 服务化 Serve | 带服务契约的角色 + 部署者计费键 | A2A 常驻对话服务（独立端点与身份） | 驻留不因闲置回收；调用按量结算 |

## 接入

- 人：壹座 web（${base}）、谦面市场（${base}/#/packs）、五编辑器 CLI（npx @finddatatechnology/facet install <packId>）。
- AI：本文件、catalog.json、每素材一页的 materials/*.md（稳定地址），以及 A2A 服务端点。

---
zh 镜像：上表即全文；本页自足，不依赖站点其他章节。Provenance: facet market · As of: ${generatedAt}
`;
  return { name: "infrastructure.md", content: zh };
}

export function buildLlmsTxt(catalog, base, generatedAt) {
  const by = (c) => catalog.materials.filter((m) => m.category === c);
  const packs = by("pack");
  const skills = by("skill");
  const mcps = by("mcp");
  const facades = by("facade");
  const anchors = by("official-data");
  // 计数按物种逐个报（fix-supply-machine-faces 3.1）：不出现任何跨物种合称。
  // 五物种的名字取自 CATEGORY_ENUM，机器面与 catalog.json 用同一套词。
  const speciesLine = [
    `${packs.length} packs`,
    `${skills.length} skills`,
    `${mcps.length} MCP servers (${catalog.counts.tools} public tools)`,
    `${facades.length} facades`,
    `${anchors.length} official data anchors`,
  ].join(", ");
  const lines = [
    `# ${PLAZA_NAME.en}（壹座·智能体素材广场）`,
    "",
    `> The outward understanding surface of the Yizuo platform: what materials exist, how the platform supplies them, and how to obtain each one. Every item below is a material — something a human or an AI agent can understand, obtain, and run. Five species: ${speciesLine}. Canonical data: ${base}/catalog.json. As of: ${generatedAt}.`,
    "",
    "## Machine surfaces",
    "",
    `- [catalog.json](${base}/catalog.json): every material with a canonical brief, five-locale human summaries, whenToUse, and provenance — the annotation-layer shape this platform already runs internally.`,
    `- [infrastructure.md](${base}/generated/infrastructure.md): the supply mechanism as an input–action–output table (publish / obtain / run / serve), self-contained.`,
    "",
    `## Packs (${packs.length} — one self-contained page each, stable addresses)`,
    "",
  ];
  for (const m of packs) {
    lines.push(`- [${m.human.en.name}](${base}/generated/materials/${m.slug}.md): ${m.canonical.brief.slice(0, 140)}`);
  }
  lines.push("", `## Skills (${skills.length})`, "");
  for (const m of skills) {
    lines.push(`- [${m.human["zh-CN"].name}](${base}/generated/materials/${m.slug}.md): ${m.canonical.brief.slice(0, 140)}`);
  }
  lines.push("", `## MCP servers (${mcps.length} — ${catalog.counts.tools} public tools embedded per page)`, "");
  for (const m of mcps) {
    lines.push(`- [${m.human["zh-CN"].name}](${base}/generated/materials/${m.slug}.md): ${m.canonical.brief.slice(0, 140)}${m.endpoint ? ` · endpoint: ${m.endpoint}` : ""}`);
  }
  lines.push("", `## Facades (${facades.length})`, "");
  for (const m of facades) {
    lines.push(`- [${m.human["zh-CN"].name}](${base}/generated/materials/${m.slug}.md): ${m.canonical.brief.slice(0, 140)}${m.endpoint ? ` · endpoint: ${m.endpoint}` : ""}`);
  }
  lines.push("", `## Official data anchors (${anchors.length})`, "");
  for (const m of anchors) {
    lines.push(`- [${m.human["zh-CN"].name}](${base}/generated/materials/${m.slug}.md): ${m.canonical.brief.slice(0, 140)}`);
  }
  lines.push("", "## For humans", "");
  lines.push(`- [The plaza site](${base}/): five-locale narrative face — what materials exist, how they are supplied, live inventory.`);
  lines.push(`- [Market actions](${base}/#/packs): browse, subscribe, install — the action layer on the same truth.`);
  return `${lines.join("\n")}\n`;
}

// Curated skill-summary translations (site-plaza/translations/skills.json —
// name-keyed {en,es,fr,ja}; zh source text stays in the registry). Missing file
// or missing entry = zh fallback, never a gate failure.
function loadSkillTranslations() {
  try {
    return JSON.parse(fs.readFileSync(new URL("../site-plaza/translations/skills.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
}

// ── pack detail fetch (v2: pack pages enumerate their own contents) ──
export async function fetchPackContents(base, packs, { fetchImpl = fetchJson } = {}) {
  const out = {};
  for (const p of packs) {
    try {
      const det = await fetchImpl(`${base}/api/packs/${encodeURIComponent(p.id)}`);
      const pack = det?.pack ?? det ?? {};
      const manifest = pack.manifest ?? {};
      out[p.id] = {
        skills: (manifest.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? "" })),
        mcpServers: (manifest.mcpServers ?? []).map((x) => ({ registryName: x.registryName ?? x.name ?? String(x) })),
      };
    } catch {
      // contents are an enrichment, not the material itself — a failed detail
      // fetch omits the section and is recorded in the snapshot, never invented
      out[p.id] = null;
    }
  }
  return out;
}

// ── main ──
export async function runExport({ base = DEFAULT_BASE, siteBase = process.env.PLAZA_SITE_BASE || "https://agent.finddatatech.cloud", outDir = "site-plaza/generated", fixture = null, allowStale = false, whitelist = [], now = new Date() } = {}) {
  // `now` 只为可测：周期刷新的验收要求「两次 generatedAt 相差一个周期」，而这值是日期、
  // 同一天重跑不变——没有注入点就只能等一天。默认 `new Date()`，生产行为一字未改；
  // 测试传两个相差一天的 now 即可确定性验证「隔天必然前进」。
  const generatedAt = now.toISOString().slice(0, 10);
  if (fixture) return runFixture({ fixture, siteBase, outDir, whitelist, generatedAt });
  try {
    return await runFresh({ base, siteBase, outDir, whitelist, generatedAt });
  } catch (err) {
    // Gate reds (err.gateViolations) are real failures — never papered over
    // with a stale snapshot. Any other error (network/HTTP) may fall back.
    if (!allowStale || err.gateViolations) throw err;
    // --allow-stale: the registries are unreachable; continue from the last
    // snapshot. Provenance keeps the OLD generatedAt (honest face); gates
    // G2/G3 still run against the replayed catalog.
    const prevPath = path.join(outDir, "catalog.json");
    if (!fs.existsSync(prevPath)) throw new Error(`--allow-stale: no previous snapshot at ${prevPath} and the registries are unreachable (${err.message})`);
    const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    const materials = prev.materials ?? [];
    const gateViolations = [];
    gateViolations.push(...lintAnnotationShape(materials).map((v) => `G2 ${v}`));
    const catalog = buildCatalog(materials);
    const materialPages = buildMaterialPages(materials, siteBase, prev.generatedAt);
    const infra = buildInfrastructurePage(prev.generatedAt, siteBase);
    const llms = buildLlmsTxt(catalog, siteBase, prev.generatedAt);
    const pages = [...materialPages, infra];
    gateViolations.push(...lintAiReadable(pages).map((v) => `G3 ${v}`));
    if (gateViolations.length > 0) {
      const e = new Error(`plaza-export gates red (stale):\n${gateViolations.join("\n")}`);
      e.gateViolations = gateViolations;
      throw e;
    }
    writeArtifacts(outDir, { catalog, materialPages, infra, llms, generatedAt: prev.generatedAt, stale: true, packsListing: null });
    return { generatedAt: prev.generatedAt, counts: catalog.counts, stale: true, materials: materials.length };
  }
}

async function runFresh({ base, siteBase, outDir, whitelist, generatedAt }) {
  // three species, three public faces
  const listingsByLocale = {};
  for (const locale of LOCALES) {
    listingsByLocale[locale] = (await fetchListedForLocale(base, locale)).filter((p) => admissionPredicate(p, whitelist));
  }
  let marketplaceCount = null;
  try {
    const mp = await fetchJson(`${base}/api/marketplace/marketplace.json`);
    marketplaceCount = Array.isArray(mp?.plugins) ? mp.plugins.length : null;
  } catch {
    marketplaceCount = null;
  }

  // skills: single anonymous face (zh source text; no locale tracks by design)
  let skills = [];
  try {
    const sk = await fetchJson(`${base}/api/skills-catalog?page=1&pageSize=${SKILLS_PAGE_SIZE}`);
    skills = sk?.skills ?? [];
  } catch (err) {
    const e = new Error(`skills-catalog fetch failed: ${err.message}`);
    e.__plazaFetch = true;
    throw e;
  }

  // mcp: per-locale lists (annotation projection) + one depth fetch per server
  const mcpByLocale = {};
  for (const locale of LOCALES) {
    try {
      const mc = await fetchJson(`${base}/api/mcp-catalog?page=1&pageSize=500&locale=${locale}`);
      mcpByLocale[locale] = mc?.servers ?? [];
    } catch (err) {
      const e = new Error(`mcp-catalog fetch failed (${locale}): ${err.message}`);
      e.__plazaFetch = true;
      throw e;
    }
  }
  const mcpNames = mcpByLocale[LOCALES[0]].map((s) => s.name);
  const mcpDepths = {};
  for (const name of mcpNames) {
    try {
      mcpDepths[name] = await fetchJson(`${base}/api/mcp-catalog/${encodeURIComponent(name)}`);
    } catch {
      mcpDepths[name] = null; // depth is an enrichment; page falls back to list fields
    }
  }

  // facade + data-anchor species (add-supply-catalog-unification): each admits
  // through its own source face. A source that is unconfigured or unreachable
  // yields zero entries for that species — honest absence, never a fabricated
  // row, and never a build failure for the other species (spec: 源缺席=计数 0).
  let facades = [];
  let facadeSourceAbsent = false;
  try {
    const fc = await fetchJson(`${base}/api/facades-catalog`);
    facades = fc?.facades ?? [];
    facadeSourceAbsent = fc?.source_absent === true;
  } catch {
    facades = [];
    facadeSourceAbsent = true;
  }
  let anchors = [];
  let anchorSourceAbsent = false;
  try {
    const ac = await fetchJson(`${base}/api/data-anchors-catalog`);
    anchors = ac?.anchors ?? [];
    anchorSourceAbsent = ac?.source_absent === true;
  } catch {
    anchors = [];
    anchorSourceAbsent = true;
  }

  const allListed = listingsByLocale[LOCALES[0]] ?? [];
  const gateViolations = [];

  // G1 packs — count authority stays the production single-rule endpoint
  if (marketplaceCount != null && marketplaceCount !== allListed.length) {
    gateViolations.push(`G1 packs: filtered listing=${allListed.length}, /api/marketplace/marketplace.json plugins=${marketplaceCount}`);
  }

  // pack contents enrichment (detail face; failures recorded, never invented)
  const contents = await fetchPackContents(base, allListed);
  for (const p of allListed) p.contents = contents[p.id] ?? undefined;

  const packMaterials = annotatePack(listingsByLocale, generatedAt, base);
  const skillsTr = loadSkillTranslations();
  const skillMaterials = skills.map((s) => annotateSkill(s, generatedAt, `${base}/api/skills-catalog`, skillsTr[s.name] ?? null)).filter(Boolean);
  const mcpMaterials = mcpNames.map((name) => {
    const listByLocale = Object.fromEntries(LOCALES.map((l) => [l, (mcpByLocale[l] ?? []).find((s) => s.name === name)].filter(Boolean)));
    return annotateMcp(listByLocale, mcpDepths[name], generatedAt, `${base}/api/mcp-catalog`);
  }).filter(Boolean);
  const facadeMaterials = facades.map((f) => annotateFacade(f, generatedAt, `${base}/api/facades-catalog`)).filter(Boolean);
  const anchorMaterials = anchors.map((a) => annotateDataAnchor(a, generatedAt, `${base}/api/data-anchors-catalog`)).filter(Boolean);
  const materials = [...packMaterials, ...skillMaterials, ...mcpMaterials, ...facadeMaterials, ...anchorMaterials];

  // G1 species set-equality: every ingested id must land in the catalog —
  // catches mapping drops. Count equality catches duplicates.
  const catalogIds = new Set(materials.map((m) => m.id));
  for (const s of skills) {
    if (!catalogIds.has(`skill:${s.name}`)) gateViolations.push(`G1 skills: "${s.name}" ingested but missing from catalog`);
  }
  if (skillMaterials.length !== skills.length) {
    gateViolations.push(`G1 skills: exported=${skillMaterials.length}, source=${skills.length}`);
  }
  for (const name of mcpNames) {
    if (!catalogIds.has(`mcp:${name}`)) gateViolations.push(`G1 mcp: "${name}" ingested but missing from catalog`);
  }
  if (mcpMaterials.length !== mcpNames.length) {
    gateViolations.push(`G1 mcp: exported=${mcpMaterials.length}, source=${mcpNames.length}`);
  }
  for (const f of facades) {
    if (!catalogIds.has(`facade:${f.id}`)) gateViolations.push(`G1 facades: "${f.id}" ingested but missing from catalog`);
  }
  if (facadeMaterials.length !== facades.length) {
    gateViolations.push(`G1 facades: exported=${facadeMaterials.length}, source=${facades.length}${facadeSourceAbsent ? " (source absent)" : ""}`);
  }
  for (const a of anchors) {
    if (!catalogIds.has(`anchor:${a.id}`)) gateViolations.push(`G1 data-anchors: "${a.id}" ingested but missing from catalog`);
  }
  if (anchorMaterials.length !== anchors.length) {
    gateViolations.push(`G1 data-anchors: exported=${anchorMaterials.length}, source=${anchors.length}${anchorSourceAbsent ? " (source absent)" : ""}`);
  }

  gateViolations.push(...lintAnnotationShape(materials).map((v) => `G2 ${v}`));

  const catalog = buildCatalog(materials);
  const materialPages = buildMaterialPages(materials, siteBase, generatedAt);
  const infra = buildInfrastructurePage(generatedAt, siteBase);
  const llms = buildLlmsTxt(catalog, siteBase, generatedAt);
  const pages = [...materialPages, infra];
  gateViolations.push(...lintAiReadable(pages).map((v) => `G3 ${v}`));

  if (gateViolations.length > 0) {
    const err = new Error(`plaza-export gates red:\n${gateViolations.join("\n")}`);
    err.gateViolations = gateViolations;
    throw err;
  }

  writeArtifacts(outDir, { catalog, materialPages, infra, llms, generatedAt, stale: false, packsListing: allListed, skillsListing: skills, base });
  return { generatedAt, counts: catalog.counts, materials: materials.length, packs: allListed.length, marketplaceCount };
}

function runFixture({ fixture, siteBase, outDir, whitelist, generatedAt }) {
  const fx = JSON.parse(fs.readFileSync(fixture, "utf8"));
  // The fixture simulates the raw network listing — the same admission
  // predicate applies on both paths (one rule, two transports).
  const listingsByLocale = Object.fromEntries(
    Object.entries(fx.listingsByLocale).map(([l, packs]) => [l, packs.filter((p) => admissionPredicate(p, whitelist))]),
  );
  const skills = fx.skills ?? [];
  const mcpServers = fx.mcpServers ?? [];
  const mcpByLocale = fx.mcpByLocale ?? { "zh-CN": mcpServers };
  const mcpDepths = fx.mcpDepths ?? {};
  const facades = fx.facades ?? [];
  const anchors = fx.dataAnchors ?? [];
  const allListed = listingsByLocale[LOCALES[0]] ?? [];
  const gateViolations = [];

  if (fx.marketplaceCount != null && fx.marketplaceCount !== allListed.length) {
    gateViolations.push(`G1 packs: filtered listing=${allListed.length}, marketplace.json plugins=${fx.marketplaceCount}`);
  }

  const packMaterials = annotatePack(listingsByLocale, generatedAt, "fixture://facet");
  const skillsTr = loadSkillTranslations();
  const skillMaterials = skills.map((s) => annotateSkill(s, generatedAt, "fixture://skills-catalog", skillsTr[s.name] ?? null)).filter(Boolean);
  const mcpMaterials = mcpServers.map((s) => {
    const listByLocale = Object.fromEntries(
      LOCALES.map((l) => [l, (mcpByLocale[l] ?? mcpServers).find((x) => x.name === s.name)].filter(Boolean)),
    );
    return annotateMcp(listByLocale, mcpDepths[s.name] ?? null, generatedAt, "fixture://mcp-catalog");
  }).filter(Boolean);
  const facadeMaterials = facades.map((f) => annotateFacade(f, generatedAt, "fixture://facades-catalog")).filter(Boolean);
  const anchorMaterials = anchors.map((a) => annotateDataAnchor(a, generatedAt, "fixture://data-anchors-catalog")).filter(Boolean);
  const materials = [...packMaterials, ...skillMaterials, ...mcpMaterials, ...facadeMaterials, ...anchorMaterials];

  const catalogIds = new Set(materials.map((m) => m.id));
  for (const s of skills) if (!catalogIds.has(`skill:${s.name}`)) gateViolations.push(`G1 skills: "${s.name}" ingested but missing from catalog`);
  if (skillMaterials.length !== skills.length) gateViolations.push(`G1 skills: exported=${skillMaterials.length}, source=${skills.length}`);
  for (const s of mcpServers) if (!catalogIds.has(`mcp:${s.name}`)) gateViolations.push(`G1 mcp: "${s.name}" ingested but missing from catalog`);
  if (mcpMaterials.length !== mcpServers.length) gateViolations.push(`G1 mcp: exported=${mcpMaterials.length}, source=${mcpServers.length}`);
  for (const f of facades) if (!catalogIds.has(`facade:${f.id}`)) gateViolations.push(`G1 facades: "${f.id}" ingested but missing from catalog`);
  if (facadeMaterials.length !== facades.length) gateViolations.push(`G1 facades: exported=${facadeMaterials.length}, source=${facades.length}`);
  for (const a of anchors) if (!catalogIds.has(`anchor:${a.id}`)) gateViolations.push(`G1 data-anchors: "${a.id}" ingested but missing from catalog`);
  if (anchorMaterials.length !== anchors.length) gateViolations.push(`G1 data-anchors: exported=${anchorMaterials.length}, source=${anchors.length}`);

  gateViolations.push(...lintAnnotationShape(materials).map((v) => `G2 ${v}`));

  const catalog = buildCatalog(materials);
  const materialPages = buildMaterialPages(materials, siteBase, generatedAt);
  const infra = buildInfrastructurePage(generatedAt, siteBase);
  const llms = buildLlmsTxt(catalog, siteBase, generatedAt);
  const pages = [...materialPages, infra];
  gateViolations.push(...lintAiReadable(pages).map((v) => `G3 ${v}`));

  if (gateViolations.length > 0) {
    const err = new Error(`plaza-export gates red:\n${gateViolations.join("\n")}`);
    err.gateViolations = gateViolations;
    throw err;
  }

  writeArtifacts(outDir, { catalog, materialPages, infra, llms, generatedAt, stale: false, packsListing: allListed, skillsListing: skills });
  return { generatedAt, counts: catalog.counts, materials: materials.length };
}

function writeArtifacts(outDir, { catalog, materialPages, infra, llms, generatedAt, stale, packsListing, skillsListing = null, base = "" }) {
  fs.mkdirSync(path.join(outDir, "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "snapshot.json"),
    JSON.stringify({ generatedAt, source: base, admission: "public+non-unlisted+curated (loadListedPacks mirror)", count: packsListing?.length ?? catalog.counts.packs, stale, packs: packsListing ?? [] }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "llms.txt"), llms);
  fs.writeFileSync(path.join(outDir, "llms-full.txt"), `${llms}\n${materialPages.map((p) => `\n---\n\n${p.content}`).join("")}`);
  fs.writeFileSync(path.join(outDir, "infrastructure.md"), infra.content);
  for (const p of materialPages) fs.writeFileSync(path.join(outDir, p.name), p.content);
  fs.writeFileSync(
    path.join(outDir, "counts.json"),
    JSON.stringify({ generatedAt, stale, packs: catalog.counts.packs, skills: catalog.counts.skills, mcpServers: catalog.counts.mcpServers, tools: catalog.counts.tools, byCategory: CATEGORY_ENUM.map((c) => ({ category: c, count: catalog.materials.filter((m) => m.category === c).length })) }, null, 2),
  );
  // skills listing rides the snapshot dir for audit (fallback + audit face)
  if (skillsListing) fs.writeFileSync(path.join(outDir, "skills-snapshot.json"), JSON.stringify({ generatedAt, count: skillsListing.length, skills: skillsListing }, null, 2));
}

// CLI entry
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const fixture = opt("--fixture");
  const allowStale = args.includes("--allow-stale");
  const outDir = opt("--out") ?? "site-plaza/generated";
  const base = opt("--base") ?? DEFAULT_BASE;
  try {
    const r = await runExport({ base, outDir, fixture, allowStale });
    const c = r.counts ?? {};
    console.log(`plaza-export OK: ${r.materials} materials (packs ${c.packs} / skills ${c.skills} / mcp ${c.mcpServers} / tools ${c.tools}), stale=${Boolean(r.stale)}, as of ${r.generatedAt}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
