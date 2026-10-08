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

export function registerFacetMcpRoutes(app, {
  resolveUser,
  entriesFn, // injection seam; default reads the registry bridge snapshot
  refreshFn = null, // optional forced refresh before serving (tests inject noop)
}) {
  const listVisible = (entries, viewer) => {
    const groups = new Set(viewer?.groups ?? []);
    return entries
      .filter((e) => {
        const required = Array.isArray(e.groups) ? e.groups : [];
        return required.length === 0 || required.some((g) => groups.has(g));
      })
      .map((e) => ({
        name: e.name,
        displayName: e.displayName || e.name,
        description: e.description || "",
        endpoint: e.configTemplate?.url ?? "",
        requiredGroups: Array.isArray(e.groups) ? e.groups : [],
      }));
  };

  app.get("/api/mcp-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const entries = entriesFn();
    res.json({ servers: listVisible(entries, viewer) });
  });

  return { listVisible };
}

// Boot wiring: start the bridge's TTL refresh against the real registry and
// hand its snapshot to the route. Degrades to an empty catalog when the
// registry source is unconfigured or unreachable (last-good kept by the
// bridge itself). No per-request refresh — initRegistryBridge already owns
// the boot fetch + TTL timer.
export async function initFacetMcpCatalog(app, { resolveUser }) {
  const bridge = await import("../registry-bridge.js");
  bridge.initRegistryBridge({});
  return registerFacetMcpRoutes(app, {
    resolveUser,
    entriesFn: () => bridge.getMarketEntries().mcpServers ?? [],
  });
}