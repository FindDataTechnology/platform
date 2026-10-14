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
// Group metadata is absent from listings, so visibility groups come from the
// optional local registry-groups.json mapping file.
import { bundledJson } from "./paths.js";
import { readJsonOr } from "./lib/persistence.js";

const REGISTRY_URL = (
  process.env.MARKET_REGISTRY_URL ||
  process.env.REGISTRY_URL ||
  ""
).trim().replace(/\/+$/, "");
const REGISTRY_TOKEN = (process.env.MARKET_REGISTRY_TOKEN || "").trim();
const TTL_SECS = Number(process.env.MARKET_REGISTRY_TTL_SECS || 300);
const FETCH_TIMEOUT_MS = 10_000;

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

// Sanitize a registry path ("/currenttime", "/skills/pdf-processing") into a
// filesystem/DB-safe name segment.
function pathToName(p) {
  return String(p || "").split("/").filter(Boolean).join("-");
}

// ── mappers: registry API shapes → paas catalog shapes ───────────────────────

// Server summary → market MCP entry. requiresConfig is derived downstream from
// the headers placeholder (extension-store), so gateway entries always sort as
// "needs config" and the setup form asks for the token at install time.
// Live-probed note: mcp_endpoint is currently null on list responses; the
// derived {REGISTRY_URL}/{path}/mcp URL is confirmed working (registry's own
// test-mcp-client.sh uses the same shape). Prefer mcp_endpoint if the registry
// ever starts populating it.
function mapServer(s) {
  if (!s?.path || s.is_enabled === false) return null;
  const name = pathToName(s.path);
  const endpoint =
    typeof s.mcp_endpoint === "string" && s.mcp_endpoint
      ? s.mcp_endpoint
      : `${REGISTRY_URL}/${name}/mcp`;
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
    groups: groupsFor("servers", name),
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

// ── refresh ──────────────────────────────────────────────────────────────────

async function doRefresh() {
  loadGroups();
  // Array vs object: GET /api/agents returns a bare list in current builds;
  // accept a wrapper too, defensively.
  const [serversDoc, skillsDoc, agentsDoc] = await Promise.all([
    fetchJson("/api/servers?limit=500"),
    fetchJson("/api/skills?limit=500"),
    fetchJson("/api/agents"),
  ]);
  const mcpServers = (serversDoc?.servers || []).map(mapServer).filter(Boolean);
  const skills = (skillsDoc?.skills || []).map(mapSkill).filter(Boolean);
  const agentsRaw = Array.isArray(agentsDoc) ? agentsDoc : agentsDoc?.agents || [];
  const agents = agentsRaw.map(mapAgent).filter(Boolean);
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
// No URL ⇒ permanent no-op (the bridge is disabled, nothing to refresh).
export function refreshRegistry() {
  if (!REGISTRY_URL) return Promise.resolve();
  if (inflight) return inflight;
  inflight = doRefresh()
    .catch((err) =>
      console.warn(`[registry-bridge] fetch failed (keeping last-good): ${err.message}`),
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

export function getRegistryLoginPath() {
  return (process.env.MARKET_REGISTRY_LOGIN_PATH || "/login").trim();
}

// The per-user token mint contract, as recorded in the ops runbook against the
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

// ── lifecycle ────────────────────────────────────────────────────────────────

export function initRegistryBridge({ broadcast, fetchImpl: impl } = {}) {
  broadcastFn = broadcast || null;
  if (impl) fetchImpl = impl;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!REGISTRY_URL) {
    console.log("[registry-bridge] no MARKET_REGISTRY_URL/REGISTRY_URL; registry source disabled");
    return;
  }
  // Boot readiness never waits on the registry (mirrors catalog's cloud merge):
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
