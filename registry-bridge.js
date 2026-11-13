// registry-bridge.js — ingestion from a self-hosted mcp-gateway-registry
// (https://github.com/agentic-community/mcp-gateway-registry).
//
// Mirrors catalog.js conventions: module state + accessors, no DB, absent
// config degrades to a no-op. One adapter serves two consumers — the market
// catalog (extension-store.js) and the agent catalog (catalog.js) — so
// fetch/cache/degradation logic exists once.
//
// Auth model (design D1): a service token fetches a GLOBAL snapshot
// (MARKET_REGISTRY_TOKEN bearer header); per-user visibility is computed
// downstream per-request from entry group metadata. A user-token pass-through
// mode can later replace the auth provider without touching consumers.
//
// Field mapping is pinned to the registry's own api/registry_client.py models
// (see the change's design.md spike notes): server summaries carry
// {path, display_name, description, is_enabled, health_status, status} and no
// URL — the client-facing MCP endpoint is derived as {REGISTRY_URL}/{path}/mcp.
// Group metadata (carry-registry-visibility-through-bridge): server rows now
// carry {visibility, allowed_groups} — the bridge computes group gating from
// the carried metadata and the hand-mapped registry-groups.json file is the
// FALLBACK for rows from a pre-upgrade registry (see visibilityGroups). A
// group-restricted entry never degrades to public (fail-closed sentinel).
import { bundledJson } from "./paths.js";
import { readJsonOr } from "./lib/persistence.js";
import { mergeAnnotations } from "./lib/supply-annotations.js";
import { getRepoAnnotation, getRepoSkillAnnotation, loadRepoAnnotations } from "./lib/market-annotations.js";

const REGISTRY_URL = (
  process.env.MARKET_REGISTRY_URL ||
  process.env.REGISTRY_URL ||
  ""
).trim().replace(/\/+$/, "");
const REGISTRY_TOKEN = (process.env.MARKET_REGISTRY_TOKEN || "").trim();
const TTL_SECS = Number(process.env.MARKET_REGISTRY_TTL_SECS || 300);
const FETCH_TIMEOUT_MS = 10_000;

// Unified supply catalog channel (add-supply-catalog-unification): when
// FACET_CATALOG_URL is configured, the market catalog is read from the facet
// catalog API family (the single supply-catalog read path) instead of the
// registry directly. FACET_CATALOG_TOKEN rides the facet internal credential
// (x-facet-internal-token) for the global read — without it the projection is
// the public subset, which is honest. The direct MARKET_REGISTRY_URL feed
// stays alive during a deprecation window (loud warning), and when both are
// configured FACET_CATALOG_URL wins.
const FACET_CATALOG_URL = (process.env.FACET_CATALOG_URL || "").trim().replace(/\/+$/, "");
const FACET_CATALOG_TOKEN = (process.env.FACET_CATALOG_TOKEN || "").trim();

// Which catalog source this deployment reads (extension-store branches on it):
// "facet" — the unified supply catalog; "legacy" — the direct registry feed
// (deprecation window); "none" — offline (starter floor + generated snapshot).
export function getCatalogSource() {
  if (FACET_CATALOG_URL) return "facet";
  if (REGISTRY_URL) return "legacy";
  return "none";
}

// "Is this entry a market entry?" — the ONE judgment every consumer (pack
// install, preset→draft conversion, market install) branches on
// (fix-facet-catalog-install-parity). The catalog's sourcing channel decides
// the origin label (`registry` from the legacy feed, `facet-catalog` from the
// projection) but NOT the entry's standing: both serve the same first-party
// market species, with the same group gate and the same credential-shaped
// install. Comparing against "registry" by hand is what silently turned the
// whole chain off when the deployment moved to the facet projection.
// `bundled` (installer-shipped stdio starters) is deliberately NOT a market
// entry — a pack reference to one keeps the local-binding rule.
const MARKET_ORIGINS = new Set(["registry", "facet-catalog"]);

export function isMarketInstallableEntry(entry) {
  return Boolean(entry) && MARKET_ORIGINS.has(entry.origin);
}

// Optional visibility mapping: {servers:{<name>:[groups]}, skills:{...},
// agents:{...}}. Absent file ⇒ every entry is group-less (visible to all).
// Resolved at READ time — see catalog.js (cwd overlay may land after boot).
const groupsFile = () => bundledJson("registry-groups.json");

// ── state ────────────────────────────────────────────────────────────────────

let marketSnapshot = { mcpServers: [], skills: [] };
let agentSnapshot = [];
let marketSig = null;
let timer = null;
let broadcastFn = null;
let fetchImpl = globalThis.fetch;
let inflight = null;
let groupsDoc = null;

// ── helpers ──────────────────────────────────────────────────────────────────

// Re-read once per refresh (not per entry); also picks up operator edits to
// the mapping file at the next TTL tick.
function loadGroups() {
  groupsDoc = readJsonOr(groupsFile(), null, { label: "registry-groups" });
}

function groupsFor(kind, name) {
  const groups = groupsDoc?.[kind]?.[name];
  return Array.isArray(groups) ? groups : [];
}

// Fail-closed sentinel (carry-registry-visibility-through-bridge 3.2): a
// group-restricted entry that lists no allowed_groups maps to this
// never-matchable group so the legacy "no required groups = public" rule can
// never leak it to any viewer. The registry write side already rejects
// restricted-without-groups; this is the residue defense for hand-edited/
// imported rows, and reconciliation names it as the defect (MCP-REGISTRY
// 台账口径，与「特殊条目缺归属组即缺陷」同轨).
const RESTRICTED_UNGROUPED = "__restricted_ungrouped__";

// Carried registry metadata wins over the hand-mapped registry-groups.json:
//   visibility=public          → groups [] (official default-visible stance)
//   visibility=group-restricted→ allowed_groups verbatim; empty → sentinel
//   visibility=private/unknown → sentinel (fail-closed; unknown values are a
//                                 data anomaly, never treated as public)
//   no visibility field        → hand mapping (pre-upgrade registry compat
//                                 window; byte-identical to pre-change rows)
function visibilityGroups(s, name) {
  const vis = typeof s?.visibility === "string" && s.visibility ? s.visibility : null;
  if (vis === null) return groupsFor("servers", name);
  if (vis === "public") return [];
  const carried = Array.isArray(s.allowed_groups) ? s.allowed_groups.filter(Boolean) : [];
  if (carried.length) return carried;
  console.warn(
    `[registry-bridge] "${name}": visibility=${vis} carries no allowed_groups — ` +
      `mapping to the never-matchable sentinel (fail-closed); reconcile the registry entry`,
  );
  return [RESTRICTED_UNGROUPED];
}

async function fetchJson(endpoint) {
  const headers = { Accept: "application/json" };
  if (REGISTRY_TOKEN) headers.Authorization = `Bearer ${REGISTRY_TOKEN}`;
  const res = await fetchImpl(`${REGISTRY_URL}${endpoint}`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
  return res.json();
}

// ── paginated list reads ─────────────────────────────────────────────────────
// Registry list endpoints are PAGINATED: they default to limit=20 and report
// {total_count, limit, offset, has_next}. Reading one page and treating it as
// the full set silently drops entries — production hit this on /api/agents
// (23 entries, 20 returned, the tail invisible with no error). A fixed large
// `limit` only moves the cliff, so reads follow has_next until it clears.

const LIST_PAGE_LIMIT = 500; // requested page size; the registry may clamp it
const LIST_MAX_PAGES = 100; // runaway guard (500 × 100 ≫ any real registry)

function listItemsOf(doc, path) {
  if (Array.isArray(doc)) return doc;
  const key = path === "/api/agents" ? "agents" : path === "/api/servers" ? "servers" : "skills";
  return doc?.[key] ?? doc?.items ?? doc?.agents ?? doc?.servers ?? doc?.skills ?? [];
}

// Read every page of a registry list endpoint.
// Returns {items, complete}. `complete:false` means the registry reported more
// entries than were retrieved (has_next still true when we stopped) — the
// caller decides what to do; this helper never silently pretends it is whole.
// Non-2xx throws (a 422 for an out-of-range limit must NOT read as "no more
// data"), so callers keep their existing last-good behavior.
async function fetchAllPages(path, { pageLimit = LIST_PAGE_LIMIT } = {}) {
  const items = [];
  let offset = 0;
  let complete = false;
  let reportedTotal = null;
  const seenFirstPaths = new Set();
  for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
    const doc = await fetchJson(`${path}?limit=${pageLimit}&offset=${offset}`);
    const rows = listItemsOf(doc, path);
    // Guard against a registry that ignores offset and replays the same page:
    // if this page's first entry was already returned by an earlier page, the
    // offset is not advancing — stop instead of piling up duplicates.
    const firstPath = rows.length ? (rows[0]?.path ?? rows[0]?.name ?? null) : null;
    if (page > 0 && firstPath !== null && seenFirstPaths.has(firstPath)) break;
    if (firstPath !== null) seenFirstPaths.add(firstPath);
    items.push(...rows);
    const total = Number.isFinite(Number(doc?.total_count)) ? Number(doc.total_count) : null;
    if (total !== null) reportedTotal = total;
    // has_next is the contract; fall back to total_count for older registries.
    const hasNext =
      typeof doc?.has_next === "boolean"
        ? doc.has_next
        : total !== null
          ? items.length < total
          : rows.length >= pageLimit;
    if (!hasNext) {
      complete = true;
      break;
    }
    if (rows.length === 0) break;
    const nextOffset = offset + rows.length;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }
  if (!complete) {
    console.warn(
      `[registry-bridge] ${path}: truncated read — retrieved ${items.length} of ${reportedTotal ?? "?"} entries (registry reports more)`,
    );
  }
  return { items, complete };
}

// Sanitize a registry path ("/currenttime", "/skills/pdf-processing") into a
// filesystem/DB-safe name segment.
function pathToName(p) {
  return String(p || "").split("/").filter(Boolean).join("-");
}

// Supply annotation passthrough (add-mcp-annotation-overlay): an annotation is
// carried verbatim when object-shaped; every other value (a stale string, an
// array) degrades to null — validation happens at the merge point.
function plainMetadataAnnotations(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

// ── mappers: registry API shapes → paas catalog shapes ───────────────────────

// Server summary → market MCP entry. requiresConfig is derived downstream from
// the headers placeholder (extension-store), so gateway entries always sort as
// "needs config" and the setup form asks for the token at install time.
// Live-probed note: mcp_endpoint is currently null on list responses; the
// derived {REGISTRY_URL}/{path}/mcp URL is confirmed working (registry's own
// test-mcp-client.sh uses the same shape). The registry's own mcp_endpoint /
// proxy_pass_url are upstream addressing — NEVER client-visible (they point at
// mesh nodes / tailnet IPs). The gateway route {REGISTRY_URL}/{path}/mcp is the
// only sanctioned consumer URL, so mapServer derives it unconditionally; the
// guard below rewrites any internal-form URL that somehow reaches an assembly
// exit (defense in depth for future callers).

// Matches deployment-internal hosts: mesh MagicDNS names, tailnet CGNAT,
// loopback, and bare-IP:port forms. Anything hit means upstream addressing
// leaked into a consumer surface — replaced, never rendered.
const INTERNAL_URL_PATTERN =
  /^https?:\/\/([^/]*mesh\.finddata\.cn|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|127\.\d+\.\d+\.\d+|localhost)(:\d+)?/i;

function gatewayEndpoint(name) {
  return `${REGISTRY_URL}/${name}/mcp`;
}

function consumerEndpoint(name, candidate) {
  if (typeof candidate !== "string" || !candidate) return gatewayEndpoint(name);
  if (INTERNAL_URL_PATTERN.test(candidate)) {
    console.warn(
      `[registry-bridge] internal-form URL blocked from consumer surface for "${name}"; deriving gateway endpoint instead`,
    );
    return gatewayEndpoint(name);
  }
  return candidate;
}

function mapServer(s) {
  if (!s?.path || s.is_enabled === false) return null;
  const name = pathToName(s.path);
  const endpoint = gatewayEndpoint(name);
  return {
    name,
    displayName: s.display_name || name,
    description: s.description || "",
    category: Array.isArray(s.tags) && s.tags[0] ? String(s.tags[0]) : "Registry",
    icon: "box",
    configTemplate: {
      url: endpoint,
      headers: { Authorization: "Bearer <your_token>" },
    },
    installInstructions:
      "Served through your MCP gateway. Fill in your gateway access token.",
    origin: "registry",
    // Visibility groups (carry-registry-visibility-through-bridge): carried
    // registry metadata wins over the hand-mapped registry-groups.json — see
    // visibilityGroups. A group-restricted entry never falls back to []=public:
    // empty groups map to the never-matchable sentinel (fail-closed).
    groups: visibilityGroups(s, name),
    // Tool surface snapshot (add-mcp-tool-scoping 5.3): the registry entry's
    // stored tool_list rides the catalog so the pack editor's tool picker can
    // offer real names; null when the entry predates a snapshot refresh.
    toolList: toolListNames(s.tool_list),
    // Depth-view fields (add-facet-infra-pages): names-only toolList stays as
    // the pack editor's contract; the facet depth view reads these instead.
    // Provenance renders honestly — absent fields stay absent (never invented).
    toolDetails: toolDetails(s.tool_list),
    license: typeof s.license === "string" && s.license && s.license !== "N/A" ? s.license : null,
    providerOrganization:
      typeof s.provider_organization === "string" && s.provider_organization
        ? s.provider_organization
        : null,
    numTools: Number.isFinite(Number(s.num_tools)) ? Number(s.num_tools) : null,
    tags: Array.isArray(s.tags) ? s.tags.map((t) => String(t)) : [],
    // Hosting tier as declared on the entry ("remote" | "local" | …).
    deployment: typeof s.deployment === "string" && s.deployment ? s.deployment : null,
    // Credential requirement declared by the registering line
    // (add-facet-market-credentials D4): entries may carry
    // metadata.credential_ref naming the 壹座-side credentialRef installs
    // must wire and require (default "registry" — the incumbent behavior).
    // Supply annotation (add-mcp-annotation-overlay D1/D7): two curated
    // sources merge field-wise right here — the registry row's
    // metadata.annotations wins over the repo file market-annotations.json
    // entry (missing fields backfilled), which exists because registry
    // metadata is 64KB-capped and DB rows are not GitOps-reviewable. The
    // snapshot feeds both planes (extension-store merges further with the
    // bundled catalog's annotation key; facet projects per locale). Both
    // sources absent → null (raw upstream rendering, byte-identical).
    annotations: mergeAnnotations({
      registry: plainMetadataAnnotations(s.metadata?.annotations),
      catalog: getRepoAnnotation(name),
    }),
    credentialRef:
      typeof s.metadata?.credential_ref === "string" && s.metadata.credential_ref
        ? s.metadata.credential_ref
        : null,
  };
}

// Depth-view tool shape (add-facet-infra-pages): name + description per tool,
// from the same stored snapshot. Kept separate from toolListNames so the pack
// editor's names-only contract is untouched.
function toolDetails(toolList) {
  if (!Array.isArray(toolList)) return null;
  const out = [];
  for (const t of toolList) {
    if (typeof t === "string") out.push({ name: t, description: "" });
    else if (t && typeof t === "object" && typeof t.name === "string") {
      out.push({ name: t.name, description: typeof t.description === "string" ? t.description : "" });
    }
  }
  return out.length ? out : null;
}

// `tool_list` entries are tool OBJECTS ({name, description, schema, …}), not
// name strings — observed on every production entry. Names-only is what the
// catalog and the publish gate compare against, so normalize once here rather
// than at each consumer (a String(t) coercion silently yields "[object Object]").
export function toolListNames(toolList) {
  if (!Array.isArray(toolList)) return null;
  const names = [];
  for (const t of toolList) {
    if (typeof t === "string") names.push(t);
    else if (t && typeof t === "object" && typeof t.name === "string") names.push(t.name);
  }
  return names.length ? names : null;
}
// One bounded fetch of /api/servers distilled to what the gate needs: the
// tool_list snapshot, the commercial surface (a NAME list from
// metadata.surface.commercial_tools — the pre-enrichment shape carries only
// counts, surfaced as surfaceCountsOnly so the gate can skip closure with an
// observable note instead of guessing), and the probe endpoint.
let serverIndexCache = { at: 0, map: null };
export async function registryServerIndex({ maxAgeMs = 60_000, fetchImpl: overrideFetch = null } = {}) {
  if (serverIndexCache.map && Date.now() - serverIndexCache.at < maxAgeMs) return serverIndexCache.map;
  // Same authenticated REGISTRY_URL-relative channel as doRefresh; tests
  // override with a bare (path → doc) fetch.
  const impl = overrideFetch || ((endpoint) => fetchJson(endpoint));
  const doc = await impl("/api/servers?limit=500");
  const rows = Array.isArray(doc?.servers) ? doc.servers : [];
  const map = new Map();
  for (const s of rows) {
    if (!s?.path || s.is_enabled === false) continue;
    const name = pathToName(s.path);
    const surface = s.metadata?.surface;
    let commercialTools = null;
    let surfaceCountsOnly = false;
    if (Array.isArray(surface?.commercial_tools)) {
      commercialTools = surface.commercial_tools.map((t) => String(t));
    } else if (surface && Number.isFinite(Number(surface.tools_commercial))) {
      surfaceCountsOnly = true;
    }
    map.set(name, {
      toolList: toolListNames(s.tool_list),
      commercialTools,
      surfaceCountsOnly,
      endpoint:
        typeof s.mcp_endpoint === "string" && s.mcp_endpoint
          ? s.mcp_endpoint
          : `${REGISTRY_URL}/${name}/mcp`,
    });
  }
  serverIndexCache = { at: Date.now(), map };
  return map;
}

// Skill card → market skill entry (metadata only; content is fetched lazily at
// install time via getSkillContent, the service token never reaches the client).
function mapSkill(s) {
  if (!s?.path || s.is_enabled === false) return null;
  const name = pathToName(String(s.path).split("/").filter(Boolean).pop());
  if (!name) return null;
  return {
    name,
    displayName: s.name || name,
    description: s.description || "",
    category: Array.isArray(s.tags) && s.tags[0] ? String(s.tags[0]) : "Registry",
    icon: "file-text",
    origin: "registry",
    contentPath: s.path,
    groups: groupsFor("skills", name),
    // Provenance (add-facet-infra-pages; openspec: ecosystem-curation): the
    // facet skills catalog renders these marks; absent stays absent.
    repositoryUrl: typeof s.repository_url === "string" && s.repository_url ? s.repository_url : null,
    author: typeof s.author === "string" && s.author ? s.author : null,
    version: typeof s.version === "string" && s.version ? s.version : null,
    tags: Array.isArray(s.tags) ? s.tags.map((t) => String(t)) : [],
    // Supply annotation (add-mcp-annotation-overlay / add-skill-display-
    // annotations R1=方案 B): the SAME merge shape as mapServer — the registry
    // row's top-level metadata.annotations wins when present, the repo file's
    // `skills` key backfills (five-language human track per skill name). The
    // registry serializer's metadata.extra fold is deliberately NOT read:
    // that landing spot is a serialization accident (SkillMetadata only
    // passes author/version/extra), and curating through the reviewed repo
    // file keeps one source of truth. Both absent → null (raw rendering).
    annotations: mergeAnnotations({
      registry: plainMetadataAnnotations(s.metadata?.annotations),
      catalog: getRepoSkillAnnotation(name)?.annotation,
    }),
  };
}

// Agent card → catalog agent-remote (link mode). Registry cards carry no
// description field; externalTags/tags map to the catalog's display tags.
// Registry group membership maps to the catalog's `roles` — the field its
// role-visibility rule reads.
function mapAgent(a) {
  if (!a?.path || a.is_enabled === false) return null;
  const name = pathToName(a.path);
  const id = `registry-${name}`;
  // A2A agents (add-a2a-agent-serving 5.1): the registry's reverse proxy
  // exposes them at {REGISTRY_URL}/agent{path}/ behind caller auth — they are
  // chat-able Agent Services, not external links, and whatever url the entry
  // carries (a private backend) is irrelevant to callers.
  const isA2a = String(a.supported_protocol ?? a.supportedProtocol ?? "").toLowerCase() === "a2a";
  const entry = {
    id,
    type: "agent-remote",
    mode: isA2a ? "a2a" : "link",
    name: a.name || id,
    url: isA2a ? `${REGISTRY_URL.replace(/\/+$/, "")}/agent${a.path}/` : a.url,
    icon: "bot",
    tags: Array.isArray(a.externalTags)
      ? a.externalTags
      : Array.isArray(a.external_tags)
        ? a.external_tags
        : undefined,
    roles: groupsFor("agents", name),
  };
  if (!entry.url) {
    console.warn(`[registry-bridge] agent '${a.path}' has no url — dropped`);
    return null;
  }
  return entry;
}

// ── facet catalog mappers (add-supply-catalog-unification) ──────────────────

// facet /api/mcp-catalog row → market MCP entry. The endpoint facet publishes
// is the gateway URL; the user's gateway token is filled at install time, so
// the placeholder keeps requiresConfig === true (same posture as mapServer).
function mapFacetServer(r) {
  if (!r?.name) return null;
  // A facet row may declare which stored credential its server needs
  // (credential-refs); pass it through unchanged so the install path resolves
  // the right ref instead of defaulting every entry to the market credential.
  // Absent ⇒ no field at all (payload stays byte-identical to before).
  const credentialRef = r.credentialRef ?? r.metadata?.credentialRef ?? null;
  return {
    name: r.name,
    displayName: r.displayName || r.name,
    description: r.description || "",
    category: "Catalog",
    icon: "box",
    configTemplate: {
      url: r.endpoint || gatewayEndpoint(r.name),
      headers: { Authorization: "Bearer <your_token>" },
    },
    installInstructions: "Served through your MCP gateway. Fill in your gateway access token.",
    origin: "facet-catalog",
    groups: Array.isArray(r.requiredGroups) ? r.requiredGroups : [],
    ...(credentialRef ? { credentialRef } : {}),
    // The global read carries the raw annotation object (facet attaches
    // `annotations` only for internal reads); the public projection carries
    // the locale-projected `annotation` only. Absent → null (raw rendering).
    annotations: plainMetadataAnnotations(r.annotations) ?? null,
  };
}

// facet /api/skills-catalog row → market skill entry. Content is fetched at
// install time through the catalog face by NAME (facet proxies the registry's
// SKILL.md), so no contentPath rides the entry.
function mapFacetSkill(r) {
  if (!r?.name) return null;
  return {
    name: r.name,
    displayName: r.displayName || r.name,
    description: r.description || "",
    category: "Catalog",
    icon: "file-text",
    origin: "facet-catalog",
    groups: Array.isArray(r.requiredGroups) ? r.requiredGroups : [],
    repositoryUrl: r.repositoryUrl ?? null,
    author: r.author ?? null,
    version: r.version ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    annotations: plainMetadataAnnotations(r.annotations) ?? null,
  };
}

// Fill `toolList` on facet-sourced entries from the depth endpoint. Bounded
// concurrency (the refresh runs on a 300 s TTL, so a few seconds is free) and
// fully degradable: a server whose depth call fails keeps no toolList, which is
// exactly what the market served before this ran.
const FACET_DEPTH_CONCURRENCY = 4;

async function attachFacetToolLists(servers, grab) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < servers.length) {
      const entry = servers[cursor++];
      try {
        const doc = await grab(`/api/mcp-catalog/${encodeURIComponent(entry.name)}?locale=zh-CN`);
        const tools = Array.isArray(doc?.tools)
          ? doc.tools.map((t) => t?.name).filter((n) => typeof n === "string" && n)
          : [];
        if (tools.length > 0) entry.toolList = tools;
      } catch {
        // One unreachable depth endpoint must not cost the whole refresh.
      }
    }
  };
  const lanes = Math.min(FACET_DEPTH_CONCURRENCY, servers.length);
  await Promise.all(Array.from({ length: lanes }, worker));
}

async function doFacetRefresh() {
  const headers = { Accept: "application/json" };
  if (FACET_CATALOG_TOKEN) headers["x-facet-internal-token"] = FACET_CATALOG_TOKEN;
  const grab = async (endpoint) => {
    const res = await fetchImpl(`${FACET_CATALOG_URL}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
    return res.json();
  };
  const [mcpDoc, skillDoc] = await Promise.all([
    grab("/api/mcp-catalog?locale=zh-CN"),
    grab("/api/skills-catalog?locale=zh-CN"),
  ]);
  const mcpServers = (mcpDoc.servers ?? []).map(mapFacetServer).filter(Boolean);
  const skills = (skillDoc.skills ?? []).map(mapFacetSkill).filter(Boolean);
  // The projection's LIST endpoint carries no tool surface (fix-facet-catalog-
  // install-parity): only the per-server depth endpoint knows the tools. The
  // pack editor's allowlist picker reads `toolList` off the market payload, so
  // without this a facet deployment can only author `fullSurface` packs.
  // Measured: 27 servers, ~95 ms each, ~2.7 s sequential against a 300 s TTL —
  // run it bounded and let any failure degrade that one entry to "no surface"
  // (the pre-change behavior) instead of failing the refresh.
  await attachFacetToolLists(mcpServers, grab);
  if (mcpServers.length === 0 && skills.length === 0) {
    // Same last-good posture as the registry channel: an empty answer is not
    // trusted over a previously good snapshot.
    throw new Error("facet catalog returned no entries");
  }
  marketSnapshot = { mcpServers, skills };
  // The registry agents leg is source-independent (fix-cell-catalog-a2a-face):
  // the facet projection serves the mcp/skills MARKET species only — the
  // chat/serving AGENTS face (a2a entries the cell catalog, fleet posts and
  // room summoning all read) lives in the registry's /api/agents. Fetch it
  // here best-effort with the same credentials the legacy channel used; a
  // failure degrades independently — keep last-good agents, warn, and never
  // fail the mcp/skills refresh that already succeeded above.
  if (REGISTRY_URL) {
    try {
      const agentsList = await fetchAllPages("/api/agents");
      agentSnapshot = agentsList.items.map(mapAgent).filter(Boolean);
    } catch (err) {
      console.warn(
        `[registry-bridge] facet agents fetch failed (keeping last-good): ${err.message}`,
      );
    }
  }
  const sig = JSON.stringify({ mcpServers, skills });
  if (sig !== marketSig) {
    marketSig = sig;
    broadcastFn?.({ type: "market_changed" });
  }
}

// ── refresh ──────────────────────────────────────────────────────────────────

async function doRefresh() {
  loadGroups();
  // Repo annotation source (D7): re-stat the file once per refresh tick (the
  // loader caches by mtime); mapServer reads the map per entry. Missing or
  // corrupt file → empty table → entries render unannotated, never a failure.
  loadRepoAnnotations(bundledJson("market-annotations.json"));
  // All three are paginated reads — see fetchAllPages. /api/agents used to be
  // read bare here, which silently capped the agent catalog at the default
  // page size (live: 23 entries, 20 returned).
  const [serversList, skillsList, agentsList] = await Promise.all([
    fetchAllPages("/api/servers"),
    fetchAllPages("/api/skills"),
    fetchAllPages("/api/agents"),
  ]);
  const mcpServers = serversList.items.map(mapServer).filter(Boolean);
  const skills = skillsList.items.map(mapSkill).filter(Boolean);
  const agents = agentsList.items.map(mapAgent).filter(Boolean);
  if (mcpServers.length === 0 && skills.length === 0 && agents.length === 0) {
    // Auth failures and API changes both surface as empty lists; keeping a
    // previous good snapshot beats wiping the market on a bad response.
    throw new Error("registry returned no entries");
  }
  marketSnapshot = { mcpServers, skills };
  agentSnapshot = agents;
  const sig = JSON.stringify({ mcpServers, skills });
  if (sig !== marketSig) {
    marketSig = sig;
    broadcastFn?.({ type: "market_changed" });
  }
}

// Single-flight: overlapping TTL ticks and manual refreshes share one fetch.
// Dispatches by the configured source (facet / legacy); "none" is a no-op.
export function refreshRegistry() {
  const source = getCatalogSource();
  if (source === "none") return Promise.resolve();
  if (inflight) return inflight;
  const run = source === "facet" ? doFacetRefresh : doRefresh;
  inflight = run()
    .catch((err) =>
      console.warn(`[registry-bridge] ${source} fetch failed (keeping last-good): ${err.message}`),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ── accessors ────────────────────────────────────────────────────────────────

// Mapped market entries (unfiltered — per-user group filtering lives in
// extension-store.getMarketCatalog, which owns catalog assembly).
export function getMarketEntries() {
  return marketSnapshot;
}

// Catalog-shaped agent entries (catalog.js merges them by id).
export function getAgentEntries() {
  return agentSnapshot;
}

// Registry base URL ("" when the source is disabled) and the path of its own
// login page. The connect popup needs both; neither is a secret.
export function getRegistryUrl() {
  return REGISTRY_URL;
}

// standardize-mcp-public-endpoints: single normalize exit for any surface that
// re-renders registry-sourced URLs to end customers (plaza generators, install
// forms, deep views). Blocks internal deployment positions from consumer planes.
export function consumerEndpointFor(name, candidate) {
  return consumerEndpoint(name, candidate);
}

export function isInternalFormUrl(candidate) {
  return typeof candidate === "string" && INTERNAL_URL_PATTERN.test(candidate);
}

export function getRegistryLoginPath() {
  return (process.env.MARKET_REGISTRY_LOGIN_PATH || "/login").trim();
}

// The per-user token mint contract, as recorded in DEPLOY.md against the
// deployed registry: GET {csrfPath} → a CSRF token, then POST {tokensPath} with
// that value in the X-CSRF-Token header. Both calls ride the user's registry
// session cookie, which is why only the browser (the connect popup) can make
// them, and why the registry must CORS-allow this origin with credentials.
// Paths are overridable because the registry is a self-hosted image whose
// routes have moved between versions.
export function getRegistryMint() {
  return {
    csrfPath: (process.env.MARKET_REGISTRY_CSRF_PATH || "/api/auth/csrf-token").trim(),
    tokensPath: (process.env.MARKET_REGISTRY_TOKENS_PATH || "/api/tokens/generate").trim(),
    csrfHeader: "X-CSRF-Token",
    defaultTtlHours: 168,
  };
}

// Fetch a registry skill's raw SKILL.md (frontmatter included).
export async function getSkillContent(contentPath) {
  const p = String(contentPath || "");
  const apiPath = p.startsWith("/skills/")
    ? p.slice("/skills".length)
    : p.startsWith("/")
      ? p
      : `/${p}`;
  const doc = await fetchJson(`/api/skills${apiPath}/content`);
  if (typeof doc?.content !== "string") {
    throw new Error(`no content returned for ${contentPath}`);
  }
  return doc.content;
}

// Fetch a market skill's raw SKILL.md (frontmatter included), routed by the
// active catalog source: the facet channel proxies content through the catalog
// face by NAME (facet holds the registry credential, 壹座 never needs it); the
// legacy channel fetches from the registry by contentPath. The service token
// stays server-side either way — the browser never sees it.
export async function fetchMarketSkillContent(entry) {
  if (getCatalogSource() === "facet") {
    const headers = { Accept: "application/json" };
    if (FACET_CATALOG_TOKEN) headers["x-facet-internal-token"] = FACET_CATALOG_TOKEN;
    const res = await fetchImpl(
      `${FACET_CATALOG_URL}/api/skills-catalog/${encodeURIComponent(entry.name)}/content`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} for skill content "${entry.name}"`);
    const doc = await res.json();
    if (typeof doc?.content !== "string") {
      throw new Error(`no content returned for ${entry.name}`);
    }
    return doc.content;
  }
  return getSkillContent(entry.contentPath);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export function initRegistryBridge({ broadcast, fetchImpl: impl } = {}) {
  broadcastFn = broadcast || null;
  if (impl) fetchImpl = impl;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const source = getCatalogSource();
  if (source === "none") {
    console.log("[registry-bridge] no catalog source; market serves the starter floor + generated snapshot");
    return;
  }
  if (source === "facet") {
    if (REGISTRY_URL) {
      console.warn(
        "[registry-bridge] FACET_CATALOG_URL configured — MARKET_REGISTRY_URL/REGISTRY_URL is ignored for the mcp/skills market species (deprecated direct feed); the agents leg still reads the registry (fix-cell-catalog-a2a-face)",
      );
    }
  } else {
    // legacy channel only
    console.warn(
      "[registry-bridge] MARKET_REGISTRY_URL direct feed is DEPRECATED — set FACET_CATALOG_URL to read the unified supply catalog",
    );
  }
  // Boot readiness never waits on the source (mirrors catalog's cloud merge):
  // first snapshot lands async, then the TTL keeps it warm.
  void refreshRegistry();
  if (TTL_SECS > 0) {
    timer = setInterval(
      () => refreshRegistry(),
      Math.max(30, TTL_SECS) * 1000,
    );
    timer.unref?.();
  }
}

export function stopRegistryBridge() {
  if (timer) clearInterval(timer);
  timer = null;
}
