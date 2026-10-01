// Agent & app catalog: multi-source (local agents.json + cloud
// AGENTS_CONFIG_URL + registry agents via registry-bridge + pack agents from
// the installed-pack state + the cell's custom presets), merged by id with
// later sources winning, refreshed on an interval; a content change
// broadcasts `catalog_changed` so clients refetch GET /api/catalog. Mirrors
// extension-store.js conventions: module state + accessors, absent sources
// degrade to just the built-in local agent. The DB-backed sources are the
// pack source (installed_packs) and the user source (user_presets); the
// DB-less convention holds for every other source and for the DB-off
// degradation path.
import path from "node:path";
import { bundledJson } from "./paths.js";
import { readJsonOr } from "./lib/persistence.js";
import { getAgentEntries } from "./registry-bridge.js";
import * as db from "./db.js";

// Resolved at READ time: the operator override (cwd copy, if any) may appear
// after boot, and the historical path.resolve bound the same way lazily.
const catalogFile = () => bundledJson("agents.json");
const MCP_CONFIG_PATH = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");
const CLOUD_URL = process.env.AGENTS_CONFIG_URL?.trim() || null;
const REFRESH_SECS = Number(process.env.CATALOG_REFRESH_SECS || 60);

// The built-in local agent is always present (sources may override it). It
// carries no runtime field: server.js routes `local` to the dsh session shim.
// Its name is the deployment's brand: the agent picker lists it beside the pack
// agents, so a deployment that renamed the assistant must not keep advertising
// "Platform" here (an unset variable keeps the shipped default).
const BUILT_IN = {
  id: "local",
  type: "agent-local",
  name: (process.env.ASSISTANT_NAME || "").trim() || "Platform",
};

let localEntries = { agents: [], apps: [] };
let cloudEntries = null; // last-good cloud document (null until first success)
let lastSignature = null;
let timer = null;
let broadcastFn = null;
let changeFn = null;

// Validation: unknown type / duplicate id / missing required fields ⇒ drop the
// entry with a warning, serve the rest (spec: agent-catalog, invalid entries).
function validateEntry(entry, source) {
  const where = `[catalog] ${source} entry`;
  if (!entry || typeof entry !== "object" || !entry.id || !entry.type) {
    console.warn(`${where}: missing id or type — dropped`);
    return null;
  }
  if (entry.type === "agent-local") return entry;
  if (entry.type === "agent-remote") {
    if (entry.mode === "chat" && (!entry.baseUrl || !entry.model)) {
      console.warn(`${where} '${entry.id}': chat-mode agent-remote needs baseUrl + model — dropped`);
      return null;
    }
    if ((entry.mode === "link" || entry.mode === "a2a") && !entry.url) {
      console.warn(`${where} '${entry.id}': ${entry.mode}-mode agent-remote needs url — dropped`);
      return null;
    }
    if (entry.mode !== "chat" && entry.mode !== "link" && entry.mode !== "a2a") {
      console.warn(`${where} '${entry.id}': unknown mode '${entry.mode}' — dropped`);
      return null;
    }
    return entry;
  }
  if (entry.type === "app") {
    if (entry.kind === "link" && entry.url) return entry;
    if (entry.kind === "nango-connect" && entry.nangoUrl) return entry;
    if (entry.kind === "external-service" && entry.url) return entry;
    console.warn(`${where} '${entry.id}': kind must be "link" (with url), "nango-connect" (with nangoUrl), or "external-service" (with url) — dropped`);
    return null;
  }
  console.warn(`${where} '${entry.id}': unknown type '${entry.type}' — dropped`);
  return null;
}

function validateDoc(doc, source) {
  const agents = [];
  const apps = [];
  const seen = new Set();
  for (const e of [...(doc?.agents ?? []), ...(doc?.apps ?? [])]) {
    const v = validateEntry(e, source);
    if (!v) continue;
    if (seen.has(v.id)) {
      console.warn(`[catalog] ${source}: duplicate id '${v.id}' — second occurrence dropped`);
      continue;
    }
    seen.add(v.id);
    (v.type === "app" ? apps : agents).push(v);
  }
  return { agents, apps };
}

async function loadLocal() {
  // readJsonOr: missing file is silent (fresh installs); an unreadable or
  // unparsable file warns with the path and degrades to the empty catalog.
  localEntries = validateDoc(
    readJsonOr(catalogFile(), { agents: [], apps: [] }, { label: "catalog" }),
    "agents.json",
  );
}

async function loadCloud() {
  if (!CLOUD_URL) return;
  try {
    const r = await fetch(CLOUD_URL, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cloudEntries = validateDoc(await r.json(), "cloud");
  } catch (err) {
    // Cloud outage never empties the catalog: keep the last-good entries.
    console.warn(`[catalog] AGENTS_CONFIG_URL fetch failed (keeping last-good): ${err.message}`);
  }
}

// Merge by id: built-in → registry → packs → user presets → agents.json →
// cloud (later wins, so the cloud is the live control plane even for ids
// first defined elsewhere, and local files override remote registry, pack,
// and user-preset entries). End-user compositions outrank market packs but
// stay beneath the operator's file and the cloud control plane — the same
// "local overrides remote, cloud stays supreme" reading the pack source
// established (add-custom-presets D2). Registry agents arrive catalog-shaped
// from registry-bridge and pass the same validation as the other sources.
//
// The pack source (add-pack-marketplace) reads the cell's installed-pack state
// directly — pack agents are persona-only entries (no baseUrl/model/credential
// by design), so they bypass validateEntry's endpoint requirement and get a
// light sanity filter instead; the rest of the chat-entry machinery (local
// persona presets, picker, selection) treats them like any other chat entry.
// The role-level resource summary (add-persona-resource-sets D5): the skill
// and MCP counts of ONE persona's effective set, computed from the installed
// manifest + install report (the same snapshot the derivation composes from).
// Undeclared dimensions default to the pack-level counts; declared ones
// intersect with what the pack owns here (a declaration naming a
// collision-skipped skill narrows further — the report is the truth).
function personaResourceSummary(installed, agent) {
  const ownedSkills = new Set(
    (installed.report?.skills ?? [])
      .filter((r) => r.status === "installed" || r.status === "replaced")
      .map((r) => r.name),
  );
  const packRefs = new Set(
    (installed.manifest?.mcpServers ?? [])
      .map((m) => (typeof m?.registryName === "string" ? m.registryName : null))
      .filter(Boolean),
  );
  const decl = agent?.resources;
  if (!decl || typeof decl !== "object") return { skillCount: ownedSkills.size, mcpCount: packRefs.size, declared: false };
  const count = (declared, own) =>
    Array.isArray(declared) ? declared.filter((n) => own.has(n)).length : own.size;
  return {
    skillCount: count(decl.skills, ownedSkills),
    mcpCount: count(decl.mcpServers, packRefs),
    declared: true,
  };
}

function packAgentDoc() {
  if (!db.isDbReady()) return { agents: [], apps: [] };
  const agents = [];
  for (const installed of db.listInstalledPacks()) {
    // Only agents that actually materialized: a skipped agent (id owned by
    // another pack at install time) must not re-enter the catalog through
    // this pack's manifest — the install report is the record of what the
    // pack truly owns here.
    const reportAgents = new Map(
      (installed.report?.agents ?? []).map((r) => [r.id, r.status]),
    );
    for (const a of installed.manifest?.agents ?? []) {
      if (!a?.id || !a.name) {
        console.warn(`[catalog] pack '${installed.name}': agent entry missing id or name — dropped`);
        continue;
      }
      if (reportAgents.get(a.id) !== "installed") continue;
      agents.push({
        id: a.id,
        type: "agent-remote",
        mode: "chat",
        name: a.name,
        description: a.description || `来自功能集「${installed.name}」的角色`,
        persona: a.persona,
        tags: Array.isArray(a.tags) ? a.tags : undefined,
        icon: a.icon,
        packId: installed.packId,
        packName: installed.name,
        resourceSummary: personaResourceSummary(installed, a),
      });
    }
  }
  return { agents, apps: [] };
}

// The user-defined source (add-custom-presets D2): one persona-only chat
// entry per user_presets row. Persona-only by construction (the CRUD route
// rejects endpoint/model/credential-shaped fields), so like the pack source
// these bypass validateEntry's chat-endpoint requirement. The resource
// summary is composition-time truth: declared references intersected with
// what the cell actually has — enabled skill rows and installed servers
// (mcp.json operator layer plus enabled DB rows). An unavailable reference
// counts zero here and is omitted at composition; it regains effect when it
// becomes available again, with no stored state to repair.
function customPresetDoc() {
  if (!db.isDbReady()) return { agents: [], apps: [] };
  const operatorServers = readJsonOr(MCP_CONFIG_PATH, {}, { label: "mcp-config" }).mcpServers || {};
  const skillNames = new Set(
    db.listCustomSkills().filter((s) => s.enabled !== false).map((s) => s.name),
  );
  const serverNames = new Set([
    ...Object.keys(operatorServers),
    ...db.listExtensionConfigs().filter((c) => c.type === "mcp" && c.enabled !== false).map((c) => c.name),
  ]);
  const agents = [];
  for (const row of db.listUserPresets()) {
    agents.push({
      id: row.id,
      type: "agent-remote",
      mode: "chat",
      name: row.name,
      persona: row.persona,
      tags: row.tags.length ? row.tags : undefined,
      icon: row.icon,
      customPreset: true,
      resourceSummary: {
        skillCount: row.skills.filter((n) => skillNames.has(n)).length,
        mcpCount: row.mcpServers.filter((n) => serverNames.has(n)).length,
        declared: true,
      },
    });
  }
  return { agents, apps: [] };
}

function merged() {
  const byId = new Map();
  const registryDoc = validateDoc(
    { agents: getAgentEntries(), apps: [] },
    "registry",
  );
  for (const doc of [
    { agents: [BUILT_IN], apps: [] },
    registryDoc,
    packAgentDoc(),
    customPresetDoc(),
    localEntries,
    cloudEntries,
  ]) {
    if (!doc) continue;
    for (const e of [...doc.agents, ...doc.apps]) byId.set(e.id, e);
  }
  const all = [...byId.values()];
  return { agents: all.filter((e) => e.type !== "app"), apps: all.filter((e) => e.type === "app") };
}

// Client-facing serializer: whitelists display fields only. Secrets (apiKey,
// apiKeyEnv, resolved keys) never reach the browser (design D5). Pack-sourced
// entries additionally carry their packId (+ display name) so picker surfaces
// can badge them as focused roles (add-pack-agent-scoping); custom-preset
// entries carry their `customPreset` marker for the same purpose
// (add-custom-presets D2).
function serialize(entry) {
  const base = { id: entry.id, type: entry.type, name: entry.name || entry.id };
  // Optional display fields (all optional, all whitelisted — not secrets).
  if (entry.description) base.description = entry.description;
  if (entry.icon) base.icon = entry.icon;
  if (Array.isArray(entry.tags)) base.tags = entry.tags;
  if (entry.version) base.version = entry.version;
  if (entry.featured === true) base.featured = true;
  if (entry.packId) {
    base.packId = entry.packId;
    if (entry.packName) base.packName = entry.packName;
  }
  if (entry.customPreset) base.customPreset = true;
  // Role-level resource summary (add-persona-resource-sets D5; custom presets
  // ride the same shape) — additive serialization; older clients ignore the
  // unknown field.
  if ((entry.packId || entry.customPreset) && entry.resourceSummary) {
    const { skillCount, mcpCount, declared } = entry.resourceSummary;
    base.resourceSummary = { skillCount, mcpCount, declared };
  }
  if (entry.type === "agent-remote") {
    base.mode = entry.mode;
    if (entry.mode === "chat") base.model = entry.model;
    if (entry.mode === "link" || entry.mode === "a2a") base.url = entry.url;
  } else if (entry.type === "app") {
    base.kind = entry.kind;
    if (entry.kind === "link") base.url = entry.url;
    if (entry.kind === "external-service") {
      base.url = entry.url;
      if (entry.embedded !== undefined) base.embedded = entry.embedded;
      if (Array.isArray(entry.features)) base.features = entry.features;
    }
  }
  return base;
}

// Role visibility: an entry with a non-empty roles[] is served only when the
// user's groups intersect it. No user (auth off) means the requester is the
// machine owner — everything is visible, matching requireAdmin and market
// visibility semantics.
function visible(entry, user) {
  if (!entry.roles?.length) return true;
  if (!user) return true;
  return (user.groups ?? []).some((g) => entry.roles.includes(g));
}

export function getCatalogFor(user) {
  const cat = merged();
  return {
    agents: cat.agents.filter((e) => visible(e, user)).map(serialize),
    apps: cat.apps.filter((e) => visible(e, user)).map(serialize),
  };
}

// Full (unredacted) entries for server-side use. The remote-agent key is
// resolved here at call time: literal apiKey, else apiKeyEnv → process.env.
export function getAgentEntry(id) {
  const e = merged().agents.find((a) => a.id === id);
  if (!e) return null;
  if (e.type === "agent-remote" && e.mode === "chat") {
    return { ...e, apiKey: e.apiKey || (e.apiKeyEnv ? process.env[e.apiKeyEnv] : undefined) };
  }
  return e;
}

// Every chat-mode remote agent, unfiltered by requester. The deployment turns
// each one into a local persona preset (dsh-profile.writeCatalogAgentPresets),
// so identity here is a persona's authority — a role-gated entry must still have
// its preset ready for the groups allowed to select it.
export function getChatAgentEntries() {
  return merged().agents.filter((a) => a.type === "agent-remote" && a.mode === "chat");
}

export function getAppEntry(id) {
  return merged().apps.find((a) => a.id === id) || null;
}

// List ALL apps (all kinds). Used for general iteration when the server needs
// to know what's available without a specific id lookup. For external-service
// proxy routing, use getExternalServices() instead.
export function getAllApps() {
  return merged().apps;
}

// List all external-service apps (NEW API-style embedded services). Used by
// server.js to resolve the /external/:appId proxy to the right upstream.
// Only external-service apps are returned — link/nango-connect have their own
// routing (/api/apps/:id/connect for nango, plain link for `link`).
export function getExternalServices() {
  return merged().apps.filter((a) => a.kind === "external-service");
}

// Re-read both sources; broadcast `catalog_changed` when the merged catalog
// changed. Returns the refreshed, redacted catalog for the requesting user.
export async function refresh(user = null) {
  await Promise.all([loadLocal(), loadCloud()]);
  notifyIfChanged();
  return getCatalogFor(user);
}

// Re-broadcast when the merged catalog changed (shared by refresh + the
// async initial cloud merge). `changeFn` lets the server re-derive what depends
// on the catalog — the vertical-pack persona presets — from the new entries.
function notifyIfChanged() {
  const cat = merged();
  const sig = JSON.stringify({ agents: cat.agents.map(serialize), apps: cat.apps.map(serialize) });
  if (sig !== lastSignature) {
    lastSignature = sig;
    broadcastFn?.({ type: "catalog_changed" });
    try { changeFn?.(); } catch (e) { console.warn(`[catalog] change handler failed: ${e.message}`); }
  }
}

export async function initCatalog({ broadcast, onChange }) {
  broadcastFn = broadcast;
  changeFn = onChange ?? null;
  // Local catalog first: boot readiness must not wait on the cloud fetch (a
  // slow/unreachable AGENTS_CONFIG_URL costs up to its 10s timeout). The
  // cloud merges asynchronously and broadcasts catalog_changed on arrival;
  // the periodic refresh below keeps syncing.
  await loadLocal();
  notifyIfChanged();
  void loadCloud()
    .then(() => notifyIfChanged())
    .catch((e) => console.warn(`[catalog] initial cloud refresh failed: ${e.message}`));
  if (REFRESH_SECS > 0) {
    timer = setInterval(
      () => refresh().catch((e) => console.warn(`[catalog] periodic refresh failed: ${e.message}`)),
      REFRESH_SECS * 1000
    );
    timer.unref?.();
  }
}

export function stopCatalog() {
  if (timer) clearInterval(timer);
  timer = null;
}
