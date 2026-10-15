// ── Facet MCP catalog (add-facet-platform S2, design D6) ────────────────────
//
// The registry's MCP servers, presented as cards on the facet surface:
// read-only aggregation through registry-bridge (same env as the platform:
// REGISTRY_URL + MARKET_REGISTRY_TOKEN, 300s TTL), visibility computed per
// viewer against the same registry-groups mapping the platform market uses.
// An entry with no required groups is public; an entry with groups is visible
// to a viewer whose identity carries one of them (group names or org ids —
// the mapping lists both). The facet surface never writes registry state
// (ADR-0015: homing is management-surface only).
//
// add-facet-infra-pages widens this surface to two layers: the card list keeps
// its six-field shape (no tool surfaces in the default payload), and per-server
// depth routes carry the tool surface and provenance on demand. The skills
// catalog rides the same visibility rule over the bridge's skill entries.

export function registerFacetMcpRoutes(app, {
  resolveUser,
  entriesFn, // injection seam; default reads the registry bridge snapshot
  skillsFn = () => [], // injection seam for the skills catalog
  refreshFn = null, // optional forced refresh before serving (tests inject noop)
}) {
  // The one visibility rule both surfaces share: no groups = public, groups =
  // a viewer carrying one of them (group names or org ids).
  const visibleTo = (entry, viewer) => {
    const required = Array.isArray(entry.groups) ? entry.groups : [];
    const groups = new Set(viewer?.groups ?? []);
    return required.length === 0 || required.some((g) => groups.has(g));
  };

  const listVisible = (entries, viewer) =>
    entries
      .filter((e) => visibleTo(e, viewer))
      .map((e) => ({
        name: e.name,
        displayName: e.displayName || e.name,
        description: e.description || "",
        endpoint: e.configTemplate?.url ?? "",
        requiredGroups: Array.isArray(e.groups) ? e.groups : [],
      }));

  const listSkills = (entries, viewer) =>
    entries
      .filter((e) => visibleTo(e, viewer))
      .map((e) => ({
        name: e.name,
        displayName: e.displayName || e.name,
        description: e.description || "",
        repositoryUrl: e.repositoryUrl ?? null,
        author: e.author ?? null,
        version: e.version ?? null,
        tags: Array.isArray(e.tags) ? e.tags : [],
      }));

  app.get("/api/mcp-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const entries = entriesFn();
    res.json({ servers: listVisible(entries, viewer) });
  });

  // Per-server depth view (add-facet-infra-pages): tool surface + provenance.
  // Visibility is the same rule — an entry the viewer cannot see answers
  // not-found (probing teaches nothing, the packs private-pack posture).
  app.get("/api/mcp-catalog/:name", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const entry = entriesFn().find((e) => e.name === req.params.name);
    if (!entry || !visibleTo(entry, viewer)) {
      return res.status(404).json({ error: "Server not found" });
    }
    res.json({
      name: entry.name,
      displayName: entry.displayName || entry.name,
      description: entry.description || "",
      endpoint: entry.configTemplate?.url ?? "",
      requiredGroups: Array.isArray(entry.groups) ? entry.groups : [],
      // Depth payload — absent fields stay null; the view renders "not
      // declared" rather than inventing values (spec: honest rendering).
      tools: entry.toolDetails ?? null,
      toolCount: entry.numTools ?? entry.toolList?.length ?? null,
      license: entry.license ?? null,
      providerOrganization: entry.providerOrganization ?? null,
      deployment: entry.deployment ?? null,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    });
  });

  // Skills catalog (add-facet-infra-pages): provenance marks per
  // openspec: ecosystem-curation. Same visibility rule; read-only always.
  app.get("/api/skills-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    res.json({ skills: listSkills(skillsFn(), viewer) });
  });

  return { listVisible, listSkills, visibleTo };
}

// Boot wiring: start the bridge's TTL refresh against the real registry and
// hand its snapshot to the routes. Degrades to an empty catalog when the
// registry source is unconfigured or unreachable (last-good kept by the
// bridge itself). No per-request refresh — initRegistryBridge already owns
// the boot fetch + TTL timer.
export async function initFacetMcpCatalog(app, { resolveUser }) {
  const bridge = await import("../registry-bridge.js");
  bridge.initRegistryBridge({});
  return registerFacetMcpRoutes(app, {
    resolveUser,
    entriesFn: () => bridge.getMarketEntries().mcpServers ?? [],
    skillsFn: () => bridge.getMarketEntries().skills ?? [],
  });
}
