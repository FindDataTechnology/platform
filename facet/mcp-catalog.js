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
//
// add-mcp-annotation-overlay: supply annotations project per request locale
// through the ONE shared helper (lib/supply-annotations.js, zh 唯一回落);
// unannotated entries carry no annotation key — the payload stays
// byte-identical to the pre-change shape. Raw stored text remains in
// name/description (never replaced).

import { timingSafeEqual } from "node:crypto";
import { resolveLocale } from "../lib/pack-locale.js";
import { projectAnnotation } from "../lib/supply-annotations.js";

// The one visibility rule every MCP-server surface shares: no required groups =
// public, groups = a viewer carrying one of them (group names or org ids).
// Module-level and exported so other projections (the MCP Registry server.json
// face) consume THIS function instead of restating the predicate — a second
// copy is exactly the drift pack-marketplace forbids (design C2).
export function visibleTo(entry, viewer) {
  // add-supply-store-unification: spine-sourced entries CARRY the `visibility`
  // field and are fail-closed — anything not exactly "public" is not
  // anonymous-visible (groups gate on top of public). Bridge-legacy entries
  // don't carry the key, so the incumbent no-groups-is-public rule is
  // untouched for them. `"visibility" in entry` (not a truthiness check) is
  // the fail-closed crux: a spine row with visibility NULL carries the key
  // with a null value and must NOT fall back to public.
  if ("visibility" in entry && entry.visibility !== "public") return false;
  const required = Array.isArray(entry.groups) ? entry.groups : [];
  const groups = new Set(viewer?.groups ?? []);
  return required.length === 0 || required.some((g) => groups.has(g));
}

// Internal global-read posture (add-supply-catalog-unification): a server-side
// consumer (壹座's supply-catalog bridge) fetches the FULL set — every entry
// with its requiredGroups carried through — and computes per-user visibility
// downstream, exactly as the registry bridge's own service-token model does.
// The channel is a dedicated header checked against the facet internal
// credential; it never touches the browser proxy path (x-facet-token /
// x-facet-user) and never widens what the public domain can see.
export function internalRead(req, internalToken) {
  if (!internalToken) return false;
  const got = String(req.headers["x-facet-internal-token"] || "");
  if (!got || got.length !== internalToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(internalToken));
  } catch {
    return false;
  }
}

export function registerFacetMcpRoutes(app, {
  resolveUser,
  entriesFn, // injection seam; default reads the registry bridge snapshot
  skillsFn = () => [], // injection seam for the skills catalog
  refreshFn = null, // optional forced refresh before serving (tests inject noop)
  internalToken = "", // facet internal credential enabling the global-read channel
  skillContentFn = null, // injection seam for install-time skill content fetch
}) {
  const requestLocale = (req) =>
    resolveLocale({ locale: req.query.locale, acceptLanguage: req.headers["accept-language"] });

  const projected = (annotation, locale) => {
    if (!annotation) return undefined;
    const p = projectAnnotation(annotation, locale);
    return p ?? undefined;
  };

  // `full` (internal read) carries the raw annotation object through so the
  // consumer can merge/inspect it field-by-field; the public face keeps only
  // the locale projection (byte-identical to the pre-change shape).
  const listVisible = (entries, viewer, locale, full = false) =>
    entries
      .filter((e) => (full ? true : visibleTo(e, viewer)))
      .map((e) => {
        const row = {
          name: e.name,
          displayName: e.displayName || e.name,
          description: e.description || "",
          endpoint: e.configTemplate?.url ?? "",
          requiredGroups: Array.isArray(e.groups) ? e.groups : [],
        };
        const ann = projected(e.annotations, locale);
        if (ann) row.annotation = ann;
        if (full && e.annotations) row.annotations = e.annotations;
        return row;
      });

  const listSkills = (entries, viewer, locale, full = false) =>
    entries
      .filter((e) => (full ? true : visibleTo(e, viewer)))
      .map((e) => {
        const row = {
          name: e.name,
          displayName: e.displayName || e.name,
          description: e.description || "",
          repositoryUrl: e.repositoryUrl ?? null,
          author: e.author ?? null,
          version: e.version ?? null,
          tags: Array.isArray(e.tags) ? e.tags : [],
          requiredGroups: Array.isArray(e.groups) ? e.groups : [],
        };
        const ann = projected(e.annotations, locale);
        if (ann) row.annotation = ann;
        if (full && e.annotations) row.annotations = e.annotations;
        return row;
      });

  app.get("/api/mcp-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const full = internalRead(req, internalToken);
    const entries = entriesFn();
    res.json({ servers: listVisible(entries, viewer, requestLocale(req), full) });
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
    const locale = requestLocale(req);
    const toolAnnotations = entry.annotations?.tools ?? null;
    const tools = Array.isArray(entry.toolDetails)
      ? entry.toolDetails.map((t) => {
          const ann = toolAnnotations && typeof t?.name === "string" ? projected(toolAnnotations[t.name], locale) : undefined;
          return ann ? { ...t, annotation: ann } : t;
        })
      : (entry.toolDetails ?? null);
    const row = {
      name: entry.name,
      displayName: entry.displayName || entry.name,
      description: entry.description || "",
      endpoint: entry.configTemplate?.url ?? "",
      requiredGroups: Array.isArray(entry.groups) ? entry.groups : [],
      // Depth payload — absent fields stay null; the view renders "not
      // declared" rather than inventing values (spec: honest rendering).
      tools,
      toolCount: entry.numTools ?? entry.toolList?.length ?? null,
      license: entry.license ?? null,
      providerOrganization: entry.providerOrganization ?? null,
      deployment: entry.deployment ?? null,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    };
    const ann = projected(entry.annotations, locale);
    if (ann) row.annotation = ann;
    res.json(row);
  });

  // Skills catalog (add-facet-infra-pages): provenance marks per
  // openspec: ecosystem-curation. Same visibility rule; read-only always.
  app.get("/api/skills-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const full = internalRead(req, internalToken);
    res.json({ skills: listSkills(skillsFn(), viewer, requestLocale(req), full) });
  });

  // Install-time skill content (add-supply-catalog-unification): the registry's
  // SKILL.md, proxied through the catalog face so a consumer that reads the
  // unified catalog never needs the registry's own credential. Same visibility
  // rule — an entry the viewer cannot see answers not-found (the MCP depth-view
  // posture: existence is not disclosed). The service token stays server-side.
  app.get("/api/skills-catalog/:name/content", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const full = internalRead(req, internalToken);
    const entry = skillsFn().find((e) => e.name === req.params.name);
    if (!entry || (!full && !visibleTo(entry, viewer))) {
      return res.status(404).json({ error: "Skill not found" });
    }
    if (!skillContentFn || !entry.contentPath) {
      return res.status(503).json({ error: "skill content source not configured" });
    }
    try {
      const content = await skillContentFn(entry.contentPath);
      res.json({ name: entry.name, content });
    } catch (err) {
      res.status(502).json({ error: `skill content fetch failed: ${err.message}` });
    }
  });

  return { listVisible, listSkills, visibleTo, internalRead };
}

// Boot wiring: start the bridge's TTL refresh against the real registry and
// hand its snapshot to the routes. Degrades to an empty catalog when the
// registry source is unconfigured or unreachable (last-good kept by the
// bridge itself). No per-request refresh — initRegistryBridge already owns
// the boot fetch + TTL timer.
export async function initFacetMcpCatalog(app, { resolveUser, entriesFn = null, skillsFn = null }) {
  const bridge = await import("../registry-bridge.js");
  bridge.initRegistryBridge({});
  return registerFacetMcpRoutes(app, {
    resolveUser,
    // add-supply-store-unification: the cutover switch injects spine-store
    // readers here; default stays the registry bridge snapshot until the
    // migration window flips SUPPLY_STORE_CATALOG=1. The bridge stays the
    // skill-content channel either way (content blobs are registry
    // execution-plane assets, not registration records).
    entriesFn: entriesFn ?? (() => bridge.getMarketEntries().mcpServers ?? []),
    skillsFn: skillsFn ?? (() => bridge.getMarketEntries().skills ?? []),
    // The global-read channel rides the same internal credential the 壹座
    // proxy uses (facet/index.js FACET_INTERNAL_TOKEN) — one secret, two
    // server-verified channels; the public domain can never open it.
    internalToken: (process.env.FACET_INTERNAL_TOKEN || "").trim(),
    skillContentFn: (contentPath) => bridge.getSkillContent(contentPath),
  });
}
