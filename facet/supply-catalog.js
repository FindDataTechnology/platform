// ── Unified supply catalog (add-supply-catalog-unification, W1) ─────────────
//
// The facet catalog API family is the single catalog read path for the five
// material species (openspec: supply-catalog). Packs ride the market listing
// (marketplace-json), skills/MCP ride the registry bridge (mcp-catalog) —
// both unchanged. THIS module adds the two species that had no source of
// truth before:
//
//   · facade  — the serving plane's own public face: the 万星 catalog
//     GET {WANXING_FACADE_URL}/api/wanxing/v1/agents admits exactly the
//     publicly shared agents (private agents are absent there by that
//     service's own rule — this surface never restates admission). Entries
//     join facet's own deployment bookkeeping (registry.allDeployments()) by
//     the public route slug for provenance; live status is not reported by
//     the public face, so it renders an explicit "unknown", never invented.
//   · data-anchor — the DAAS catalog export
//     GET {DAAS_CATALOG_URL} (catalog_export.py, v1 scope: entities +
//     indicators + sources). Provenance names the DAAS catalog and as-of.
//
// Annotation posture (spec: "Annotation shape spans all species"): neither
// source carries the supply-annotation layer yet, so every entry synthesizes
// the production shape with its zh source text in all five locale slots and
// honest provenance — never machine-translated, never omitted. When an
// annotation pass lands upstream, entries carry `annotation` natively and the
// synthesis step defers to it.
//
// Both sources ride the registry-bridge conventions: module state + TTL
// refresh (MARKET_REGISTRY_TTL_SECS semantics, default 300), last-good on
// failure with a warning, absent config degrades to an honest empty face
// (source_absent: true) — never a boot failure, never a fabricated row.

import { resolveLocale } from "../lib/pack-locale.js";

const FIVE_LOCALES = ["zh", "en", "ja", "es", "fr"];

// The species enumeration (supply-catalog spec): a new species extends this
// with a version bump, never by overloading an existing value.
// v2 (unify-material-market): dsh plugins join the catalogue as their own
// species — a plugin is a material a deployment may supply, distinct from the
// pack that happens to carry one. The operator's curated plugin catalogue and
// the 申请供应 request flow both key off this value.
export const SUPPLY_SPECIES = ["pack", "skill", "mcp", "facade", "data-anchor", "plugin"];
export const SUPPLY_SPECIES_VERSION = 2;

// The public route slug of a deployed agent — mirrors the serving plane's own
// derivation (fd-wanxing services/wanxing-facade/core.js slugFor) so facet can
// join its deployment bookkeeping to the public catalog. It is the route
// identity contract between the two services, not an admission predicate.
export function slugFor(agentPath) {
  return String(agentPath || "").replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
}

// Synthesize the production annotation shape from raw text (zh in all five
// slots, honest provenance) — the honest-fallback posture the spec names for
// species not yet covered by an annotation pass.
export function zhFallbackAnnotation({ name, summary, whenToUse = null, source, updatedAt }) {
  const track = { name, summary, whenToUse };
  const human = {};
  for (const locale of FIVE_LOCALES) human[locale] = track;
  return {
    canonical: { brief: summary || name },
    human,
    whenToUse,
    provenance: { source, updatedAt },
  };
}

// ── TTL-fed source state (registry-bridge pattern, one adapter per source) ───

// Exported for tests: pin the boot-race retry contract (start() keeps polling
// on a short backoff until the first snapshot lands).
export function createSource(opts) {
  return createSourceInner(opts);
}

function createSourceInner({ url, token, label, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  let snapshot = null; // last-good parsed payload
  let fetchedAt = 0;
  let inflight = null;
  let timer = null;
  let bootTimer = null;

  const configured = () => Boolean(url);

  async function pull() {
    if (!configured()) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      snapshot = body;
      fetchedAt = Date.now();
    } catch (err) {
      // Last-good posture: keep serving the previous snapshot, say why.
      console.warn(`[supply-catalog] ${label} refresh failed (${err.message}); serving last-good`);
    } finally {
      clearTimeout(t);
      inflight = null;
    }
  }

  function ensureFresh() {
    if (!configured()) return Promise.resolve();
    if (inflight) return inflight;
    const ttlMs = Number(process.env.MARKET_REGISTRY_TTL_SECS || 300) * 1000;
    if (Date.now() - fetchedAt > ttlMs) inflight = pull();
    return inflight ?? Promise.resolve();
  }

  function start() {
    if (!configured()) return;
    pull().catch(() => {});
    const ttlMs = Number(process.env.MARKET_REGISTRY_TTL_SECS || 300) * 1000;
    timer = setInterval(() => pull().catch(() => {}), ttlMs);
    timer.unref?.();
    // Boot race quick retry: the upstream (sidecar/svc) often isn't listening
    // in the first seconds after a rollout — a failed boot pull must not pin
    // the face to source_absent for a full TTL. While no snapshot has ever
    // landed, retry on a short backoff (15s steps, 20 tries ≈ 5 min) instead.
    let bootRetries = 0;
    bootTimer = setInterval(() => {
      if (snapshot || bootRetries++ >= 20) {
        clearInterval(bootTimer);
        bootTimer = null;
        return;
      }
      pull().catch(() => {});
    }, 15_000);
    bootTimer.unref?.();
  }

  return {
    configured,
    get snapshot() { return snapshot; },
    get asOf() { return fetchedAt ? new Date(fetchedAt).toISOString() : null; },
    ensureFresh,
    start,
    stop() {
      if (timer) clearInterval(timer);
      if (bootTimer) clearInterval(bootTimer);
    },
    pull, // exposed for tests / forced refresh
  };
}

// ── Route registration (injection seams for tests) ──────────────────────────

export function registerSupplyCatalogRoutes(app, {
  resolveUser,
  deploymentsFn = () => [], // facet's own deployment bookkeeping (join source)
  facadeSource, // createSource over the 万星 public catalog
  anchorSource, // createSource over the DAAS export
  refreshFn = null, // optional forced refresh before serving (tests inject noop)
}) {
  const _requestLocale = (req) =>
    resolveLocale({ locale: req.query.locale, acceptLanguage: req.headers["accept-language"] });

  // Deployment provenance index: slug → {packId, agentId, deployedAt}.
  const deploymentBySlug = () => {
    const bySlug = new Map();
    for (const d of deploymentsFn()) {
      const slug = slugFor(d.agentPath);
      if (slug && !bySlug.has(slug)) bySlug.set(slug, { packId: d.packId, agentId: d.agentId, deployedAt: d.deployedAt });
    }
    return bySlug;
  };

  app.get("/api/supply-catalog/species", (_req, res) => {
    res.json({ species: SUPPLY_SPECIES, version: SUPPLY_SPECIES_VERSION });
  });

  app.get("/api/facades-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    else await facadeSource?.ensureFresh().catch(() => {});
    const viewer = resolveUser(req); // reserved: the public face admits by the serving plane's own rule
    const payload = facadeSource?.snapshot;
    if (!facadeSource?.configured() || !payload) {
      return res.json({ facades: [], source_absent: true });
    }
    const bySlug = deploymentBySlug();
    const asOf = facadeSource.asOf ?? new Date().toISOString();
    const facades = (payload.agents ?? [])
      .filter((a) => a && a.slug)
      .map((a) => {
        const dep = bySlug.get(a.slug) ?? null;
        const row = {
          id: a.slug,
          name: a.name || a.slug,
          description: a.description || "",
          version: a.version ?? null,
          tags: Array.isArray(a.tags) ? a.tags : [],
          // The serving plane's public face does not report live status —
          // honest unknown, never a defaulted healthy.
          status: a.status ?? "unknown",
          chatable: a.chatable === true,
          deployment: dep, // {packId, agentId, deployedAt} | null — provenance join
        };
        row.annotation = a.annotation ?? zhFallbackAnnotation({
          name: row.name,
          summary: row.description,
          whenToUse: Array.isArray(a.skills) && a.skills.length ? `skills: ${a.skills.map((s) => s?.id ?? s).filter(Boolean).join(", ")}` : null,
          source: "wanxing-facade",
          updatedAt: asOf,
        });
        return row;
      });
    res.json({ facades, viewer: viewer ? "identified" : "anonymous" });
  });

  app.get("/api/data-anchors-catalog", async (_req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    else await anchorSource?.ensureFresh().catch(() => {});
    const payload = anchorSource?.snapshot;
    if (!anchorSource?.configured() || !payload) {
      return res.json({ anchors: [], source_absent: true });
    }
    const asOf = payload.as_of ?? anchorSource.asOf ?? new Date().toISOString();
    const anchors = (payload.anchors ?? [])
      .filter((a) => a && a.id)
      .map((a) => {
        const row = {
          id: a.id,
          name: a.name,
          kind: a.kind,
          summary: a.summary || "",
          source: a.source ?? null,
        };
        row.annotation = a.annotation ?? zhFallbackAnnotation({
          name: row.name,
          summary: row.summary,
          whenToUse: null,
          source: "daas-catalog",
          updatedAt: asOf,
        });
        return row;
      });
    res.json({ anchors, as_of: asOf });
  });

  return { deploymentBySlug };
}

// Boot wiring: start the two TTL sources against their env-configured faces
// and hand their snapshots to the routes. Absent config degrades honestly
// (empty + source_absent) — the facet service never fails to boot over a
// missing feed (same posture as the registry bridge).
export function initSupplyCatalog(app, { resolveUser, registry }) {
  const facadeBase = (process.env.WANXING_FACADE_URL || "").trim().replace(/\/+$/, "");
  const facadeSource = createSource({
    url: facadeBase ? `${facadeBase}/api/wanxing/v1/agents` : "",
    token: (process.env.WANXING_FACADE_TOKEN || "").trim(),
    label: "wanxing-facade",
  });
  const anchorSource = createSource({
    url: (process.env.DAAS_CATALOG_URL || "").trim(),
    token: (process.env.DAAS_CATALOG_TOKEN || "").trim(),
    label: "daas-catalog",
  });
  facadeSource.start();
  anchorSource.start();
  return registerSupplyCatalogRoutes(app, {
    resolveUser,
    deploymentsFn: () => registry?.allDeployments?.() ?? [],
    facadeSource,
    anchorSource,
  });
}
