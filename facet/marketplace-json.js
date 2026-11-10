// ── Facet — Claude plugin-marketplace manifest face (add-ecosystem-bridge 2.5)
//
// Serves the marketplace as a native Claude Code plugin marketplace: one
// manifest in the .claude-plugin/marketplace.json format plus, per listed
// pack version, a minimal plugin source tree (plugin.json, skills as
// SKILL.md, README carrying MCP connection guidance). A Claude Code user
// adds the marketplace with one command and installs packs as plugins.
//
// Scope discipline (spec: pack-marketplace delta):
//   - public non-unlisted packs only — private AND unlisted never appear;
//   - listing admission = curated (category or featured), the same signals
//     the browse face consumes (D5; wire-marketplace-json-curation) — an
//     operator whitelist (FACET_MARKETPLACE_PACK_IDS, comma-separated ids)
//     overrides curation entirely, pinning an explicit set;
//   - MCP references appear as guidance text in the plugin README, never as
//     server configuration (the plugin body must install without a key);
//   - cache headers ≤ 1h so the listing reflects publish/unpublish within it.

import { lineOf } from "../lib/pack-category-lines.js";

const CACHE = "public, max-age=3600";

// Operator whitelist, comma-separated. Read per call so a restart-free
// config change is observed on the next request.
export function curatedPackIds(env = process.env) {
  return (env.FACET_MARKETPLACE_PACK_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The ONE listing rule. Every marketplace-shaped surface (the Claude-format
// endpoint and the repository export) calls this — a second copy would drift,
// and a listing that disagrees with the browse face has already happened once
// (wire-marketplace-json-curation). Admission = public, non-unlisted, and
// curated (category ∨ featured); a configured operator whitelist REPLACES the
// curation filter outright rather than intersecting it.
export function loadListedPacks(registry, { viewer = null, env = process.env } = {}) {
  const whitelist = curatedPackIds(env);
  const listed = (p) =>
    whitelist.length > 0 ? whitelist.includes(p.id) : Boolean(p.category || p.featured);
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const { packs = [], total = 0 } = registry.list({ page, pageSize: 100, viewer });
    for (const p of packs) {
      if (listed(p)) out.push(p);
    }
    // Filtering can hold out.length below total forever — also stop when the
    // registry stops returning pages.
    if (out.length >= total || packs.length === 0) break;
  }
  return out;
}

export function registerMarketplaceJson(app, { registry, resolveUser, officialAuthors = [] }) {
  const loadListed = (viewer) => loadListedPacks(registry, { viewer });
  // Official = the deployment-side author roster, matched case-insensitively —
  // the SAME rule the gateway mount applies (one deployment, one truth).
  // registry.list() summaries do NOT carry `official` (the route layer injects
  // it), so this face must resolve it itself or the adopted mark can never
  // appear here. Empty roster means all-false, never a missing key.
  const roster = (Array.isArray(officialAuthors) ? officialAuthors : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter(Boolean);
  const isOfficial = (email) => roster.includes(String(email ?? "").trim().toLowerCase());

  // Relative plugin sources resolve against this manifest's directory, so the
  // manifest lives under /api/marketplace/ and plugin trees under
  // /api/marketplace/packs/<id>/v<version>/.
  //
  // Adopted provenance (add-official-adopted-agents 3.2) rides the SAME
  // projection the platform surface uses — `official` (roster) ∧ `adopted`
  // (SQL-projected provenance flag) — so the two faces can never disagree.
  // Presentation only: it does not touch admission (loadListedPacks) or
  // ordering (the registry's own sort), and community packs emit no key, so
  // every pre-existing entry's payload stays byte-identical.
  app.get("/api/marketplace/marketplace.json", (req, res) => {
    const viewer = resolveUser(req);
    const plugins = loadListed(viewer).map((p) => ({
      name: p.id,
      source: `./packs/${p.id}/v${p.version}`,
      description: p.description || p.name,
      version: String(p.version),
      author: { name: "FindData · 谦面" },
      // Curation metadata (add-facet-content-management): consumers may
      // group by vertical or promote featured entries; plain Claude Code
      // ignores unknown keys harmlessly. add-legacy-pack-rebrand 2.x: the
      // category rides the归位 LINE word now (daas/data/dash/authoring/docs →
      // line words, unmapped pass through, company → "" — the facade badge
      // carries 分身). ADMISSION above still reads the row's raw slug, and
      // the curation WRITE keeps taking the original slug (zero migration).
      category: lineOf(p.category) || "",
      featured: Boolean(p.featured),
      ...(isOfficial(p.authorEmail) && p.adopted === true ? { provenance: { source: "official-adopted" } } : {}),
    }));
    res.set("Cache-Control", CACHE);
    res.json({
      name: "facet",
      owner: { name: "FindData · 谦面" },
      metadata: { description: "谦面功能集市场 — 技能/MCP/角色功能集，安装为 Claude Code 插件", homepage: process.env.PAAS_BASE_URL || "" },
      plugins,
    });
  });

  // Shared gate for every plugin file: the version must exist, be of a pack
  // that is neither private (visibility gate) nor unlisted (discovery gate).
  function loadPluginVersion(id, version, req) {
    const row = registry.getVersionVisible(id, version, resolveUser(req));
    if (!row) return null;
    if (registry.packRowPublic(id)?.unlisted) return null;
    return row;
  }

  const mcpGuidance = (manifest, registryBase) => {
    const servers = manifest?.mcpServers ?? [];
    if (servers.length === 0) return "";
    const lines = [
      "## MCP 连接指引",
      "",
      "本插件声明以下 MCP 引用（不随插件自动连接）。用 [facet CLI](https://www.npmjs.com/package/@finddatatechnology/facet) 一站完成：",
      "",
      "```",
      `npx @finddatatechnology/facet connect   # 铸取并验活 wgk- 调用键`,
      `npx @finddatatechnology/facet install <packRef> --write-mcp   # 安装技能并代写 MCP 配置`,
      "```",
      "",
    ];
    for (const s of servers) {
      lines.push(`- **${s.registryName}** — 端点 \`${registryBase}/${s.registryName}/mcp\`${s.requiredGroup ? `（需要组：${s.requiredGroup}）` : ""}`);
    }
    lines.push("", "连接需 wgk- 调用键（免费月度额度内即用）；键只在注册处，不入插件。");
    return lines.join("\n");
  };

  app.get("/api/marketplace/packs/:id/v:version/.claude-plugin/plugin.json", (req, res) => {
    const row = loadPluginVersion(req.params.id, req.params.version, req);
    if (!row) return res.status(404).json({ error: "Pack not found" });
    res.set("Cache-Control", CACHE);
    res.json({
      name: req.params.id,
      description: row.description || row.name,
      version: String(req.params.version),
      author: { name: "FindData · 谦面" },
    });
  });

  app.get("/api/marketplace/packs/:id/v:version/skills/:skill/SKILL.md", (req, res) => {
    const row = loadPluginVersion(req.params.id, req.params.version, req);
    const wanted = String(req.params.skill);
    const skill = row?.manifest?.skills?.find((s) => s.name === wanted);
    if (!skill) return res.status(404).type("text/plain").send("skill not found");
    // Same synthesized frontmatter as the raw skill-md route — one content
    // definition per skill body (pack skills are body-only).
    const fm = [`---`, `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`, `---`, ""].join("\n");
    res.set("Cache-Control", CACHE);
    res.type("text/markdown").send(`${fm}${skill.content}`);
  });

  app.get("/api/marketplace/packs/:id/v:version/README.md", (req, res) => {
    const row = loadPluginVersion(req.params.id, req.params.version, req);
    if (!row) return res.status(404).type("text/plain").send("pack not found");
    const registryBase = (process.env.FACET_REGISTRY_BASE || process.env.REGISTRY_URL || "https://mcp.finddatatech.cloud").replace(/\/+$/, "");
    const skills = row.manifest?.skills ?? [];
    const body = [
      `# ${row.name}`,
      "",
      row.description || "",
      "",
      ...(skills.length ? ["## 技能", ...skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""}`), ""] : []),
      mcpGuidance(row.manifest, registryBase),
    ].join("\n");
    res.set("Cache-Control", CACHE);
    res.type("text/markdown").send(body);
  });
}
