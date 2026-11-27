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
//
// A BARE RUN WRITES `site-plaza/generated/` (the tracked audit snapshot of the
// last scheduled export). That snapshot is produced by `.github/workflows/
// plaza-refresh.yml` against the LIVE deployment; regenerating it from a dev
// base rewrites ~700 files with a different material count. So the CLI parses
// its arguments strictly: an unknown flag is an error, not a silent full
// export — silently exporting is how a smoke test turns into a 740-file diff.

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
// Admission is VISIBILITY, not curation (pack-marketplace spec: "Curation state
// SHALL be presentation-level only"). Until 2026-11-20 this was
// `category || featured`, which silently dropped 16 public, installable packs —
// 13 of them facade packs — from every machine surface while the G1 gate stayed
// green (both sides used the same wrong predicate, so comparing them proved
// nothing). The anonymous browse face already answers public-only, so the
// predicate only has to exclude explicitly unlisted rows.
export function admissionPredicate(pack, whitelist = []) {
  if (whitelist.length > 0) return whitelist.includes(pack.id);
  if (pack?.unlisted) return false;
  return (pack?.visibility ?? "public") === "public";
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
        // surface-material-previews D2: a pack's own one-line promise is the
        // sentence a reader picks it by, and the market listing already carries
        // it (`display.promise`, projected from the manifest). Using `description`
        // here would put a 200-character paragraph where a card preview needs one
        // line — the exact fallback chain the detail page was built to replace.
        summary: (p.display?.promise ?? "").trim() || (p.description ?? ""),
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
    // 团队编制的契约级投影。刻意的窄：只有「谁是什么、什么节奏、报哪几个数、
// 谁连谁」。任何作者写的散文（persona / promptTemplate / 技能正文）都不进来。
// 返回 null 表示「这不是团队」，调用方据此不产 `team` 键。
function teamFactsOf(manifest) {
  const members = manifest?.fleet?.members;
  if (!Array.isArray(members) || members.length === 0) return null;
  const edges = manifest?.fleet?.orchestration?.edges;
  return {
    team: {
      posts: members.map((m) => ({
        ref: typeof m?.ref === "string" ? m.ref : null,
        title: typeof m?.title === "string" ? m.title : null,
        parentRef: typeof m?.parentRef === "string" ? m.parentRef : null,
        kind: typeof m?.target?.kind === "string" ? m.target.kind : null,
        // 节奏只带 cron/tz（它们是对外可读的契约）；promptTemplate 不带。
        cron: typeof m?.cadence?.cron === "string" ? m.cadence.cron : null,
        tz: typeof m?.cadence?.tz === "string" ? m.cadence.tz : null,
        kpiSlots: Array.isArray(m?.kpiSlots) ? m.kpiSlots.map((k) => k?.key).filter((k) => typeof k === "string") : [],
      })),
      edges: Array.isArray(edges)
        ? edges.map((e) => ({
            kind: typeof e?.kind === "string" ? e.kind : null,
            from: typeof e?.from === "string" ? e.from : null,
            to: typeof e?.to === "string" ? e.to : null,
          }))
        : [],
      acceptance: Array.isArray(manifest?.acceptance)
        ? manifest.acceptance.map((a) => ({
            kind: typeof a?.kind === "string" ? a.kind : null,
            target: typeof a?.target === "string" ? a.target : null,
          })).filter((a) => a.kind)
        : [],
    },
  };
}

const contents = anchor.contents ?? (anchor.manifest
      ? {
          skills: (anchor.manifest.skills ?? []).map((x) => ({ name: x.name, description: x.description ?? "" })),
          mcpServers: (anchor.manifest.mcpServers ?? []).map((x) => ({ registryName: x.registryName ?? x.name ?? String(x) })),
          // 团队编制的**契约级事实**（openspec: team-derivation / pillar-surfaces
          // 「机器面只带契约级事实，不带作者散文」）。带的是：岗位 ref 与标题、
          // 节奏 cron/tz、KPI 槽位键、编排边的 kind/from/to、验收断言的 kind/target。
          //
          // **不带**：persona 正文、promptTemplate 原文、技能正文。那三样是散文，
          // plaza 是匿名可读的机器面——`test-team-export` 有一条断言扫这里，
          // 出现 promptTemplate 即红。非团队包不产这个键（absence 保持 payload
          // 对存量包逐字节不变）。
          ...(teamFactsOf(anchor.manifest) ?? {}),
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
//
// Curation evidence (openspec: curation-evidence) rides along when the source
// face computed it. It is projected field-by-field rather than spread, because
// this object becomes a PUBLIC json: a future internal field (reviewer, per-axis
// reasons) must not reach it by default.
function outwardEvidence(ev) {
  if (!ev || typeof ev !== "object" || typeof ev.state !== "string") return null;
  const out = { state: ev.state };
  if (typeof ev.licence === "string" && ev.licence.trim()) out.licence = ev.licence;
  if (typeof ev.reviewValidUntil === "string" && ev.reviewValidUntil.trim()) out.reviewValidUntil = ev.reviewValidUntil;
  return out;
}

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
    // unify-supply-spine-lineage 5.4: the two fields that tell "what can I do
    // with this" from "is anything running it". Reported as-is from the catalog
    // (never defaulted here — a missing value means the source omitted it, and
    // inventing one would hide exactly the drift this species exists to show).
    runnable: f.runnable ?? null,
    deployment: f.deployment ?? null,
    canonical: { brief: (f.annotation?.canonical?.brief ?? summary).slice(0, 300) },
    human: Object.fromEntries(LOCALES.map((l) => [l, slot(l)])),
    whenToUse: f.annotation?.whenToUse ?? summary.slice(0, 120) ?? "A deployed agent service.",
    badges: { official: false, facade: true },
    provenance: {
      source: f.annotation?.provenance?.source ?? source,
      updatedAt: f.annotation?.provenance?.updatedAt ?? generatedAt,
    },
    ...(outwardEvidence(f.evidence) ? { evidence: outwardEvidence(f.evidence) } : {}),
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
    ...(outwardEvidence(a.evidence) ? { evidence: outwardEvidence(a.evidence) } : {}),
  };
}

// ── v2: skills species — registry visibility rule already applied upstream
// (no-required-groups = public on the anonymous face). Annotated skills carry
// their curated five-locale human track (the API faces project one locale per
// request, so the caller supplies `skillsByLocale`); zh source text is carried
// verbatim in every slot ONLY for a skill with no annotation (provenance stays
// honest; the export never fabricates a translation and never reads a side
// asset the pipeline does not produce). ──
export function annotateSkill(skill, generatedAt, source, skillsByLocale = null) {
  if (!skill?.name) return null; // malformed registry entry — the G1 count gate must see the drop
  const name = skill.displayName || skill.name;
  const summary = skill.description ?? "";
  const tags = Array.isArray(skill.tags) ? skill.tags : [];
  // Per-locale annotation row for this skill (single-locale projection, the
  // same shape the MCP species carries natively). Absent → null → source text.
  const annFor = (l) => {
    const list = skillsByLocale?.[l] ?? skillsByLocale?.["zh-CN"] ?? null;
    if (!Array.isArray(list)) return null;
    const row = list.find((s) => s.name === skill.name);
    return row?.annotation ?? null;
  };
  const zhAnn = annFor("zh-CN");
  const enAnn = annFor("en");
  return {
    id: `skill:${skill.name}`,
    slug: speciesSlug("skill", skill.name),
    category: "skill",
    marketCategory: null,
    tags: tags.slice(0, 8),
    repositoryUrl: skill.repositoryUrl ?? null,
    canonical: { brief: (enAnn?.summary ?? zhAnn?.summary ?? summary).slice(0, 300) },
    human: Object.fromEntries(
      LOCALES.map((l) => {
        const a = annFor(l);
        return [l, { name: a?.name ?? name, summary: a?.summary ?? summary }];
      }),
    ),
    whenToUse: zhAnn?.whenToUse ?? enAnn?.whenToUse ?? (tags.length ? `Relevant when working on: ${tags.join(", ")}.` : summary.slice(0, 120)),
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
// ── per-species preview entries (surface-material-previews D1/D2/D3) ────────
//
// counts.json already carries per-species COUNTS; the 全部 tab also needs a
// short preview of each species so a reader can decide which tab to open
// without fetching any inventory (the catalog's own bound: "the 全部 tab SHALL
// NOT fetch the full inventory").
//
// Three rules:
//   · ≤3 per species — the entry page mounts three of these in total, and its
//     height must not move with inventory size (entry-page-height-bounded).
//   · blurb comes from the material's OWN copy, two fallbacks only
//     (annotation summary → description/summary). No blurb ⇒ no entry: inventing
//     one is exactly the "make it look filled" failure the species descriptions
//     were added to end.
//   · the selection is STABLE (featured/official first, then name) — never
//     "newest". 2026-11-24 shipped 200+ versions in one day; a time-ordered
//     preview would show nothing but fresh test packs and change every refresh.
const PREVIEW_PER_SPECIES = 3;

/** The one sentence a material says about itself in ONE locale, in priority order.
 *  Runtime template variables (`{{fleetContext}}` and friends) are filled by the
 *  agent harness, not by a reader: a card must never show raw braces, and
 *  stripping the variable alone leaves its bracket behind ("( injected)"),
 *  which reads as a typo. When a bracketed aside contains a variable, drop the
 *  whole aside: it is parenthetical, so the sentence survives without it. */
function blurbIn(m, locale) {
  const human = m.human?.[locale] ?? {};
  const cands = [human.summary, m.canonical?.brief, m.whenToUse];
  for (const c of cands) {
    if (typeof c !== "string" || !c.trim()) continue;
    let s = c;
    if (s.includes("{{")) {
      s = s
        .replace(/[（(][^（）()]*\{\{[^}]*\}\}[^（）()]*[）)]/g, "")
        .replace(/\{\{[^}]*\}\}/g, "")
        .replace(/[（(]\s*[）)]/g, "")
        .replace(/\s*([,;、+·])\s*(?=[,;、+·])/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s,;、+·-]+|[\s,;、+·-]+$/g, "");
    }
    const cleaned = s.replace(/\s+/g, " ").trim();
    if (cleaned.length >= 2) return cleaned.slice(0, 160);
  }
  return null;
}

/** Name in one locale, with the zh main track as the only fallback. */
function nameIn(m, locale) {
  const want = (m.human?.[locale]?.name ?? "").trim();
  if (want) return want;
  return (m.human?.["zh-CN"]?.name ?? m.human?.en?.name ?? "").trim();
}

function previewBadge(m) {
  const b = m.badges ?? {};
  if (b.official) return "official";
  if (m.category === "facade") return m.runnable === false ? "undeployed" : "running";
  if (m.category === "mcp" && typeof m.toolCount === "number") return `${m.toolCount}`;
  // official-data 的预览已经只取「源」了，badge 再写 "source" 是同义反复。
  if (m.category === "official-data") return m.anchorSource ? String(m.anchorSource) : null;
  if (typeof m.toolCount === "number") return `${m.toolCount}`;
  return null;
}

/**
 * Build the per-species preview block for counts.json.
 *
 * A species with no material still gets an EMPTY ARRAY — an absent key would
 * make the shell unable to tell "this species has nothing" from "the artifact
 * predates this species", and the 全部 tab renders the two differently.
 */
export function buildPreview(materials) {
  const out = {};
  for (const species of CATEGORY_ENUM) {
    let cands = materials.filter((m) => m.category === species);
    // official-data 483 条里 461 是「指标」（SPY_ma5 这种展开项），只有 22 个是
    // 「数据源」。按名字排序会让预览全是 `000001_close`——读者看不出那是什么。
    // 预览只取源：spec 自己的说法是 "Sources are listed first; indicators expand".
    if (species === "official-data") {
      const sources = cands.filter((m) => m.anchorKind === "source");
      if (sources.length > 0) cands = sources;
    }
    // 五语槽（polish-facet-read-surfaces D7）：一张卡里不能有两种语言，所以
    // name/blurb 按导出器服务的五个 locale 各带一份，前端按读者语言取。
    const rows = cands
      .map((m) => {
        const name = Object.fromEntries(LOCALES.map((l) => [l, nameIn(m, l)]));
        const blurb = Object.fromEntries(LOCALES.map((l) => [l, blurbIn(m, l) ?? ""]));
        return { m, name, blurb };
      })
      // 判据用 zh 主轨（每条 material 都有它）：某语言缺句子只是该语言少一句，
      // 不该让整条从所有语言里消失。
      .filter((r) => r.name["zh-CN"] && r.blurb["zh-CN"])
      // A blurb that only repeats the name says nothing (「阿尔法哨兵」→「阿尔法哨兵」).
      .filter((r) => r.blurb["zh-CN"].replace(/\s/g, "") !== r.name["zh-CN"].replace(/\s/g, ""));
    // Featured/official first, then name — stable across exports.
    rows.sort((a, b) => {
      const fa = a.m.badges?.official ? 1 : 0;
      const fb = b.m.badges?.official ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return a.name["zh-CN"].localeCompare(b.name["zh-CN"], "zh-Hans-CN");
    });
    out[species] = rows.slice(0, PREVIEW_PER_SPECIES).map(({ m, name, blurb }) => {
      const badge = previewBadge(m);
      return badge ? { name, blurb, badge } : { name, blurb };
    });
  }
  return out;
}

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
    materials: materials.map(({ id, slug, category, marketCategory, tags, contents, canonical, human, whenToUse, badges, tools, toolCount, license, provider, endpoint, repositoryUrl, provenance, evidence, runnable, deployment, anchorKind, anchorSource }) => {
      const entry = { id, slug, category, marketCategory, tags, canonical, human, whenToUse, badges, provenance };
      // Curation evidence survives the catalog projection (curation-evidence):
      // a material the market lists must be able to say what was reviewed and
      // until when. Optional — a material with no evidence carries no key,
      // rather than an invented "unknown" state.
      if (evidence) entry.evidence = evidence;
      if (contents) entry.contents = contents;
      if (category === "mcp") Object.assign(entry, { tools, toolCount, license, provider, endpoint });
      if (category === "skill" && repositoryUrl) entry.repositoryUrl = repositoryUrl;
      // unify-supply-spine-lineage 5.4：facade 的两个字段必须过这一层。
      // 这里是一份**解构白名单**——不在列表里的键会被静默丢掉，而 annotateFacade
      // 明明产出了它们（2026-11-21 实撞：API 有、catalog.json 没有，排查了三轮才
      // 定位到这一行）。按物种条件挂，与 mcp/skill 的既有写法同形。
      if (category === "facade") {
        entry.runnable = runnable;
        entry.deployment = deployment;
      }
      // data-anchor 同理：kind/source 决定目录能否按 kind 分层（source 先列、
      // indicator 折叠），白名单一漏消费者就永远折叠不了。按物种条件挂。
      if (category === "official-data") {
        entry.anchorKind = anchorKind;
        entry.anchorSource = anchorSource;
      }
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

// ── projection-loss gate ────────────────────────────────────────────────────
// The supplying face (facet) projects raw upstream rows into catalog entries and
// reports what it could not keep: `dropped` = no usable identity at all,
// `coerced` = kept but with a required field that was not a string.
//
// Why this gate has to live here: the exported-vs-source equality checks below
// compare what *we received* against itself, so a row the projection already
// discarded is invisible to them by construction. The counters went live on
// facet 2026-11-14 (supply-catalog.js) and — like every other "the judge cannot
// see what it claims to check" seam — nothing read them until this gate.
export function projectionLossViolations(label, payload, endpoint) {
  if (!payload || typeof payload !== "object") return [];
  const dropped = Number(payload.dropped) || 0;
  const coerced = Number(payload.coerced) || 0;
  const out = [];
  if (dropped > 0) {
    out.push(
      `G1 ${label}: ${endpoint} dropped ${dropped} upstream row(s) before projection (no usable id) — the plaza would publish a silently shorter catalog`,
    );
  }
  if (coerced > 0) {
    out.push(
      `G1 ${label}: ${endpoint} coerced ${coerced} row(s) (required field was not a string) — published entries would carry blank fields`,
    );
  }
  return out;
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
export async function runExport({ base = DEFAULT_BASE, siteBase = process.env.PLAZA_SITE_BASE || "https://agent.finddatatech.cloud", outDir = "site-plaza/generated", fixture = null, allowStale = false, whitelist = [], previousCatalog = null, now = new Date() } = {}) {
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
    // G2/G3 still run against the replayed catalog. `previousCatalog` lets a
    // caller that exports into a fresh staging dir name the live snapshot
    // explicitly — without it, the replay source would be the empty outDir.
    const prevPath = path.join(outDir, "catalog.json");
    const replaySource = previousCatalog && fs.existsSync(previousCatalog) ? previousCatalog : prevPath;
    if (!fs.existsSync(replaySource)) throw new Error(`--allow-stale: no previous snapshot at ${replaySource} and the registries are unreachable (${err.message})`);
    const prev = JSON.parse(fs.readFileSync(replaySource, "utf8"));
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

  // skills: per-locale lists (annotation projection — the API projects one
  // locale per request). zh is the identity set; other locales mirror it so a
  // skill absent from a locale falls back to its zh row.
  const skillsByLocale = {};
  let skills = [];
  try {
    for (const locale of LOCALES) {
      const sk = await fetchJson(`${base}/api/skills-catalog?page=1&pageSize=${SKILLS_PAGE_SIZE}&locale=${locale}`);
      skillsByLocale[locale] = sk?.skills ?? [];
    }
    skills = skillsByLocale[LOCALES[0]] ?? [];
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
  // Losses are collected before `gateViolations` exists (it is declared below,
  // after the listing fetch) and folded in with the other G1 checks.
  const projectionLosses = [];
  try {
    const fc = await fetchJson(`${base}/api/facades-catalog`);
    facades = fc?.facades ?? [];
    facadeSourceAbsent = fc?.source_absent === true;
    projectionLosses.push(...projectionLossViolations("facades", fc, "/api/facades-catalog"));
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
    projectionLosses.push(...projectionLossViolations("data-anchors", ac, "/api/data-anchors-catalog"));
  } catch {
    anchors = [];
    anchorSourceAbsent = true;
  }

  const allListed = listingsByLocale[LOCALES[0]] ?? [];
  const gateViolations = [
    ...projectionLosses,
  ];

  // G1 packs — count authority stays the production single-rule endpoint
  if (marketplaceCount != null && marketplaceCount !== allListed.length) {
    gateViolations.push(`G1 packs: filtered listing=${allListed.length}, /api/marketplace/marketplace.json plugins=${marketplaceCount}`);
  }

  // pack contents enrichment (detail face; failures recorded, never invented)
  const contents = await fetchPackContents(base, allListed);
  for (const p of allListed) p.contents = contents[p.id] ?? undefined;

  const packMaterials = annotatePack(listingsByLocale, generatedAt, "market-listing");
  const skillMaterials = skills.map((s) => annotateSkill(s, generatedAt, "skills-catalog", skillsByLocale)).filter(Boolean);
  const mcpMaterials = mcpNames.map((name) => {
    const listByLocale = Object.fromEntries(LOCALES.map((l) => [l, (mcpByLocale[l] ?? []).find((s) => s.name === name)].filter(Boolean)));
    return annotateMcp(listByLocale, mcpDepths[name], generatedAt, "mcp-catalog");
  }).filter(Boolean);
  const facadeMaterials = facades.map((f) => annotateFacade(f, generatedAt, "facades-catalog")).filter(Boolean);
  const anchorMaterials = anchors.map((a) => annotateDataAnchor(a, generatedAt, "daas-catalog")).filter(Boolean);
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
  const skillsByLocale = fx.skillsByLocale ?? { "zh-CN": skills };
  const mcpServers = fx.mcpServers ?? [];
  const mcpByLocale = fx.mcpByLocale ?? { "zh-CN": mcpServers };
  const mcpDepths = fx.mcpDepths ?? {};
  const facades = fx.facades ?? [];
  const anchors = fx.dataAnchors ?? [];
  const allListed = listingsByLocale[LOCALES[0]] ?? [];
  // Fixture transport for the same gate: `facadeProjection` / `anchorProjection`
  // stand in for the counters the live facet response carries, so the red path
  // is exercisable without a network face.
  const gateViolations = [
    ...projectionLossViolations("facades", fx.facadeProjection, "fixture://facades-catalog"),
    ...projectionLossViolations("data-anchors", fx.anchorProjection, "fixture://data-anchors-catalog"),
  ];

  if (fx.marketplaceCount != null && fx.marketplaceCount !== allListed.length) {
    gateViolations.push(`G1 packs: filtered listing=${allListed.length}, marketplace.json plugins=${fx.marketplaceCount}`);
  }

  const packMaterials = annotatePack(listingsByLocale, generatedAt, "fixture://facet");
  const skillMaterials = skills.map((s) => annotateSkill(s, generatedAt, "fixture://skills-catalog", skillsByLocale)).filter(Boolean);
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
    JSON.stringify({ generatedAt, stale, packs: catalog.counts.packs, skills: catalog.counts.skills, mcpServers: catalog.counts.mcpServers, tools: catalog.counts.tools, byCategory: CATEGORY_ENUM.map((c) => ({ category: c, count: catalog.materials.filter((m) => m.category === c).length })), preview: buildPreview(catalog.materials) }, null, 2),
  );
  // skills listing rides the snapshot dir for audit (fallback + audit face)
  if (skillsListing) fs.writeFileSync(path.join(outDir, "skills-snapshot.json"), JSON.stringify({ generatedAt, count: skillsListing.length, skills: skillsListing }, null, 2));
}

// CLI entry
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const USAGE =
    "usage: node scripts/plaza-export.mjs [--base <facet-url>] [--out <dir>] [--fixture <file>] [--allow-stale]\n" +
    "  --out defaults to site-plaza/generated (the TRACKED snapshot) — pass --out when smoke-testing.";
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  // Strict parse (see the header note): a typo must not become a full export.
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const withValue = new Set(["--base", "--out", "--fixture", "--site-base", "--previous"]);
  const bare = new Set(["--allow-stale"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (bare.has(a)) continue;
    if (withValue.has(a)) {
      if (args[i + 1] == null || args[i + 1].startsWith("--")) {
        console.error(`${a} needs a value\n${USAGE}`);
        process.exit(2);
      }
      i++;
      continue;
    }
    console.error(`unknown argument: ${a}\n${USAGE}`);
    process.exit(2);
  }
  const fixture = opt("--fixture");
  const allowStale = args.includes("--allow-stale");
  const outDir = opt("--out") ?? "site-plaza/generated";
  const base = opt("--base") ?? DEFAULT_BASE;
  const siteBase = opt("--site-base") ?? undefined;
  const previousCatalog = opt("--previous");
  try {
    const r = await runExport({ base, siteBase, outDir, fixture, allowStale, previousCatalog });
    const c = r.counts ?? {};
    console.log(`plaza-export OK: ${r.materials} materials (packs ${c.packs} / skills ${c.skills} / mcp ${c.mcpServers} / tools ${c.tools}), stale=${Boolean(r.stale)}, as of ${r.generatedAt}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
