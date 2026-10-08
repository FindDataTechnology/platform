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
//   - MCP references appear as guidance text in the plugin README, never as
//     server configuration (the plugin body must install without a key);
//   - curated subset via FACET_MARKETPLACE_PACK_IDS (comma-separated ids);
//     unset lists every public pack — today every pack is operator-published,
//     the filter matters when creator publishing opens up;
//   - cache headers ≤ 1h so the listing reflects publish/unpublish within it.

const CACHE = "public, max-age=3600";

export function registerMarketplaceJson(app, { registry, resolveUser }) {
  const curatedIds = () =>
    (process.env.FACET_MARKETPLACE_PACK_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const loadListed = (viewer) => {
    const curated = curatedIds();
    const out = [];
    let page = 1;
    for (;;) {
      const { packs = [], total = 0 } = registry.list({ page, pageSize: 100, viewer });
      for (const p of packs) {
        if (curated.length > 0 && !curated.includes(p.id)) continue;
        out.push(p);
      }
      if (out.length >= total || page > 50) break;
      page += 1;
    }
    return out;
  };

  // Relative plugin sources resolve against this manifest's directory, so the
  // manifest lives under /api/marketplace/ and plugin trees under
  // /api/marketplace/packs/<id>/v<version>/.
  app.get("/api/marketplace/marketplace.json", (req, res) => {
    const viewer = resolveUser(req);
    const plugins = loadListed(viewer).map((p) => ({
      name: p.id,
      source: `./packs/${p.id}/v${p.version}`,
      description: p.description || p.name,
      version: String(p.version),
      author: { name: "FindData · 谦面" },
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
