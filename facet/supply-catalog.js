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
// Curation evidence (add-curation-evidence-gate 2.2): the outward projection is
// owned by lib/curation-evidence.js — this file never picks evidence fields by
// hand, so a new internal field cannot leak here by being added upstream.
import { evidenceSummary } from "../lib/curation-evidence.js";

const FIVE_LOCALES = ["zh", "en", "ja", "es", "fr"];

// The species enumeration (supply-catalog spec): a new species extends this
// with a version bump, never by overloading an existing value.
// v2 (unify-material-market): dsh plugins join the catalogue as their own
// species — a plugin is a material a deployment may supply, distinct from the
// pack that happens to carry one. The operator's curated plugin catalogue and
// the 申请供应 request flow both key off this value.
export const SUPPLY_SPECIES = ["pack", "skill", "mcp", "facade", "data-anchor", "plugin"];
export const SUPPLY_SPECIES_VERSION = 2;

// The public route slug of a deployed agent — pinned by
// the vendored `facet/contract/agent-identity.fixture.json` (owner:
// fd-wanxing/contracts/, all 12 cases; see scripts/test-agent-runner-identity.mjs)
// so facet can join its deployment
// bookkeeping to the public catalog. It is the route identity contract between
// the two services, not an admission predicate.
export function slugFor(agentPath) {
  return String(agentPath || "").replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
}

// ── Facade projection: shape-checked, counted, never coerced ─────────────────
//
// supply-catalog spec (retire-wanxing-twin-face 3.2/3.3): the serving plane's
// public face is a BORROWED upstream consumed as a published contract. Its
// entries are shape-checked, not trusted:
//   · a missing/blank `slug` has no identity to join on → the row is dropped
//     and counted, never projected under a fabricated id;
//   · a `status` of an unexpected type (a boolean, a number) is a contract
//     violation → dropped, because coercing it would hide the divergence;
//   · `status` values that ARE reported pass through byte-for-byte. This module
//     never invents `serving`; absence renders `unknown`.
//   · `name`/`description` fall back to the slug / empty string and are counted
//     as coerced — visible degradation, not a silent one.
//
// Pure on purpose: the counts are the observable half of the check, and they
// must be assertable without standing up a route.
export const FACADE_STATUS_UNKNOWN = "unknown";

export function projectFacadeEntries(agents, { bySlug = new Map(), asOf = null, attach = null } = {}) {
  const out = { facades: [], dropped: 0, coerced: 0 };
  if (!Array.isArray(agents)) return out;

  for (const a of agents) {
    if (!a || typeof a !== "object") { out.dropped += 1; continue; }
    const slug = typeof a.slug === "string" ? a.slug.trim() : "";
    if (!slug) { out.dropped += 1; continue; }
    // null/undefined = not reported (the honest-unknown case); any other
    // non-string = the contract was violated, so drop rather than coerce.
    const reported = a.status !== undefined && a.status !== null;
    if (reported && typeof a.status !== "string") { out.dropped += 1; continue; }

    if (typeof a.name !== "string" || a.name.trim() === "") out.coerced += 1;
    if (typeof a.description !== "string") out.coerced += 1;

    const row = {
      id: slug,
      name: typeof a.name === "string" && a.name.trim() !== "" ? a.name : slug,
      description: typeof a.description === "string" ? a.description : "",
      version: a.version ?? null,
      tags: Array.isArray(a.tags) ? a.tags : [],
      status: reported ? a.status : FACADE_STATUS_UNKNOWN,
      chatable: a.chatable === true,
      deployment: bySlug.get(slug) ?? null, // provenance join; null = no bookkeeping
    };
    row.annotation = a.annotation ?? zhFallbackAnnotation({
      name: row.name,
      summary: row.description,
      whenToUse: Array.isArray(a.skills) && a.skills.length ? `skills: ${a.skills.map((sk) => sk?.id ?? sk).filter(Boolean).join(", ")}` : null,
      source: "wanxing-facade",
      updatedAt: asOf,
    });
    // 证据摘要由调用方注入（`species: "facade"` 的挂载点）。
    // 为什么要一个钩子而不是在这里直接调 attachEvidenceSummary：
    // projectFacadeEntries 是**纯函数**（有断言守着"不修改入参"），而证据摘要
    // 需要 route 侧的 `today`/物种口径；把副作用留在 route，函数仍可在测试里
    // 单独断言 dropped/coerced。2026-11-13 并 C3 时发现：C3 侧的分支点早于
    // attachEvidenceSummary 落地，若整段取 theirs 会把该能力连同两个调用点一起删掉。
    if (typeof attach === "function") attach(row, a, { species: "facade", today: asOf });
    out.facades.push(row);
  }
  return out;
}

/**
 * 数据锚目录的投影：与 `projectFacadeEntries` 同形，理由也相同。
 *
 * 这里原本是 route 里一段内联的 `.filter(...).map(...)`——形状漂移时它只会
 * **悄悄变短**：缺 `id` 的条目被丢掉、计数为零、日志里什么都没有。同族缺陷在
 * facade 那条已经修过一次（dropped/coerced 随响应回给调用方），data-anchor 是
 * 同一个形状的第二处，所以一并抽成纯函数。
 *
 * 刻意**不改行形状**：`name`/`kind` 仍是原样透传（不是字符串就照样透传，
 * 只把它记进 `coerced`）。换掉取值会改变对外字节，而这个面还没有契约登记，
 * 没有东西能告诉你谁依赖了旧形状。
 */
export function projectAnchorEntries(anchors, { asOf = null, attach = null } = {}) {
  const out = { anchors: [], dropped: 0, coerced: 0 };
  if (!Array.isArray(anchors)) return out;

  for (const a of anchors) {
    if (!a || typeof a !== "object") { out.dropped += 1; continue; }
    const id = typeof a.id === "string" ? a.id.trim() : "";
    if (!id) { out.dropped += 1; continue; }

    if (typeof a.name !== "string" || a.name.trim() === "") out.coerced += 1;
    if (typeof a.kind !== "string") out.coerced += 1;
    if (typeof a.summary !== "string") out.coerced += 1;

    const row = {
      id,
      name: a.name,
      kind: a.kind,
      summary: a.summary || "",
      source: a.source ?? null,
    };
    // 与内联版同序：证据摘要在前、annotation 在后，字段顺序不变。
    if (typeof attach === "function") attach(row, a, { species: "data-anchor", today: asOf });

    row.annotation = a.annotation ?? zhFallbackAnnotation({
      name: row.name,
      summary: row.summary,
      whenToUse: null,
      source: "daas-catalog",
      updatedAt: asOf,
    });
    out.anchors.push(row);
  }
  return out;
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

/**
 * Attach the outward evidence summary to a catalogue row (task 2.2). Absent
 * evidence leaves the row untouched — the market face keeps rendering, and the
 * absence is visible as `state: "missing"` at the cell's supply face rather than
 * as a hole here.
 *
 * Reviewer identity never crosses this line (design D5).
 */
export function attachEvidenceSummary(row, raw, { species = "pack", today = new Date() } = {}) {
  if (!raw || raw.evidence === undefined || raw.evidence === null) return row;
  row.evidence = evidenceSummary({ evidence: raw.evidence, species: raw.species ?? species }, { today });
  return row;
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
    // 契约消费 + 可见降级（C3 的本意）：投影交给纯函数，dropped/coerced 随响应
    // 回给调用方，上游形状漂移不再是"目录悄悄变短"。
    // 证据摘要（本线后加的 attachEvidenceSummary）用钩子挂回去——C3 分支点更早，
    // 它那侧整段没有这段能力，直接取 theirs 会静默删掉 facade 与 data-anchor 两处
    // 挂载（同一文件 221/252 行那份实现里还留着）。所以这里两边都要：
    // 用 projectFacadeEntries，但把 attach 传进去。
    const { facades, dropped, coerced } = projectFacadeEntries(payload.agents, {
      bySlug,
      asOf,
      attach: (row, raw, opts) => attachEvidenceSummary(row, raw, opts),
    });
    if (dropped || coerced) {
      // Visible degradation: the counts ride the response so a silent upstream
      // shape change is observable instead of quietly shrinking the catalog.
      console.warn(`[supply-catalog] facade projection: dropped=${dropped} coerced=${coerced} of ${Array.isArray(payload.agents) ? payload.agents.length : 0}`);
    }
    res.json({ facades, dropped, coerced, viewer: viewer ? "identified" : "anonymous" });
  });

  app.get("/api/data-anchors-catalog", async (_req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    else await anchorSource?.ensureFresh().catch(() => {});
    const payload = anchorSource?.snapshot;
    if (!anchorSource?.configured() || !payload) {
      return res.json({ anchors: [], source_absent: true });
    }
    const asOf = payload.as_of ?? anchorSource.asOf ?? new Date().toISOString();
    // 与 facade 面同形：投影交给纯函数，dropped/coerced 随响应回给调用方，
    // 上游形状漂移不再表现为"锚目录悄悄变短"（见 projectAnchorEntries 注释）。
    const { anchors, dropped, coerced } = projectAnchorEntries(payload.anchors, {
      asOf,
      attach: (row, raw, opts) => attachEvidenceSummary(row, raw, opts),
    });
    if (dropped || coerced) {
      console.warn(`[supply-catalog] anchor projection: dropped=${dropped} coerced=${coerced} of ${Array.isArray(payload.anchors) ? payload.anchors.length : 0}`);
    }
    res.json({ anchors, dropped, coerced, as_of: asOf });
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
