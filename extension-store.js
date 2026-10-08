// extension-store.js
// Business logic layer for managing MCP server configs and custom skills.
// Wraps the db.js CRUD operations and provides market catalog loading.

import { bundledJson } from "./paths.js";
import { readJsonOr } from "./lib/persistence.js";
import * as db from "./db.js";
import { getMarketEntries } from "./registry-bridge.js";

// Resolved at READ time — see catalog.js: a cwd overlay may land after boot.
const marketCatalogFile = () => bundledJson("market-catalog.json");
const marketCatalogSkillsFile = () => bundledJson("market-catalog-skills.json");

// shared predicate for "this arg needs user input".
// Matches /path/..., your_..., and <...> placeholders.
// Used by both requiresConfig derivation (server) and setup-form field generation (client re-implements the same rule).
export function isPlaceholderArg(arg) {
  return /\/path\//.test(arg) || /^your_/.test(arg) || /^<.*>$/.test(arg);
}

// Header-value variant: substring match, since header values embed the
// placeholder ("Bearer <your_token>") rather than being the bare placeholder.
// The client setup form re-implements this rule (McpServerForm hasPlaceholder).
function hasPlaceholder(value) {
  return (
    typeof value === "string" &&
    (/\/path\//.test(value) || /your_/.test(value) || /<[^<>]+>/.test(value))
  );
}

// Derive whether a catalog entry needs user-supplied config.
function requiresConfig(template) {
  if (!template) return false;
  const env = template.env || {};
  if (Object.keys(env).length > 0) return true;
  const headers = template.headers || {};
  if (Object.values(headers).some(hasPlaceholder)) return true;
  const args = template.args || [];
  return args.some(isPlaceholderArg);
}

// ── MCP Server Configs ───────────────────────────────────────────────────────

export function listMcpServers() {
  return db.listExtensionConfigs().filter((c) => c.type === "mcp");
}

export function getMcpServer(name) {
  const config = db.getExtensionConfig(name);
  if (!config || config.type !== "mcp") return null;
  return config;
}

// seed on startup — skip if already present (preserves user edits).
// origin/locked/permissions come from the bundle manifest for packaged seeds
// ("bundled", locked, tool allow/deny lists); default to a plain user row.
export function seedMcpServer({ name, config, enabled = true, origin = "user", locked = false, permissions = null }) {
  return db.seedExtensionConfig({ name, type: "mcp", config, enabled, origin, locked, permissions });
}

export function addMcpServer({ name, config, enabled = true, requiredGroups = null }) {
  return db.addExtensionConfig({ name, type: "mcp", config, enabled, requiredGroups });
}

export function updateMcpServer(name, { config, enabled }) {
  return db.updateExtensionConfig(name, { type: "mcp", config, enabled });
}

export function removeMcpServer(name) {
  const server = getMcpServer(name);
  if (!server) return false;
  return db.deleteExtensionConfig(name);
}

export function toggleMcpServer(name, enabled) {
  const server = getMcpServer(name);
  if (!server) return null;
  return db.setExtensionEnabled(name, enabled);
}

// ── Custom Skills ────────────────────────────────────────────────────────────

export function listCustomSkills() {
  return db.listCustomSkills();
}

export function getCustomSkill(name) {
  return db.getCustomSkill(name);
}

export function addCustomSkill({ name, description, content, enabled = true }) {
  return db.addCustomSkill({ name, description, content, enabled });
}

export function updateCustomSkill(name, { description, content, enabled }) {
  return db.updateCustomSkill(name, { description, content, enabled });
}

export function removeCustomSkill(name) {
  const skill = getCustomSkill(name);
  if (!skill) return false;
  return db.deleteCustomSkill(name);
}

export function toggleCustomSkill(name, enabled) {
  const skill = getCustomSkill(name);
  if (!skill) return null;
  return db.setCustomSkillEnabled(name, enabled);
}

// ── Market Catalog ───────────────────────────────────────────────────────────

let marketCatalogCache = null;
let marketCatalogSkillsCache = null;

export async function loadMarketCatalog() {
  if (marketCatalogCache) return marketCatalogCache;
  const doc = readJsonOr(marketCatalogFile(), null, { label: "extensions" });
  // readJsonOr warns on parse errors; a missing/invalid file degrades to the
  // empty catalog (fresh installs ship without market catalogs).
  marketCatalogCache = doc ?? { mcpServers: [] };
  return marketCatalogCache;
}

export async function loadMarketCatalogSkills() {
  if (marketCatalogSkillsCache) return marketCatalogSkillsCache;
  const doc = readJsonOr(marketCatalogSkillsFile(), null, { label: "extensions" });
  marketCatalogSkillsCache = doc ?? { skills: [] };
  return marketCatalogSkillsCache;
}

export async function getMarketCatalog(user = null) {
  const { mcpServers, skills } = await mergedMarketCatalog();
  const servers = mcpServers.map((s) => ({
    ...s,
    requiresConfig: requiresConfig(s.configTemplate),
  }));
  // sort ready-to-use first, then alphabetical. The JSON file order is a hint, this is the source of truth.
  servers.sort((a, b) => {
    if (a.requiresConfig !== b.requiresConfig) return a.requiresConfig ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return {
    mcpServers: servers.filter((s) => visibleToUser(s, user)),
    skills: skills.filter((s) => visibleToUser(s, user)),
  };
}

// The merged catalog BEFORE per-user visibility filtering — the install
// admission check needs an entry's groups even when the requesting user must
// not see it (that's exactly the bypass it exists to close).
async function mergedMarketCatalog() {
  const [mcpServers, skills] = await Promise.all([
    loadMarketCatalog(),
    loadMarketCatalogSkills(),
  ]);
  // Registry entries (last-good snapshot from registry-bridge) merge behind
  // the bundled catalog: a bundled entry wins on name collision because it is
  // curated for this deployment.
  const registry = getMarketEntries();
  const bundledMcpNames = new Set((mcpServers.mcpServers || []).map((s) => s.name));
  const registryServers = registry.mcpServers.filter((s) => !bundledMcpNames.has(s.name));
  const bundledSkillNames = new Set((skills.skills || []).map((s) => s.name));
  const registrySkills = registry.skills.filter((s) => !bundledSkillNames.has(s.name));
  return {
    mcpServers: [...(mcpServers.mcpServers || []), ...registryServers],
    skills: [...(skills.skills || []), ...registrySkills],
  };
}

// Resolve a market MCP entry by name for the install admission check.
// Returns null when no catalog entry carries that name (a hand-entered
// config, not a market install — ungated by definition).
export async function findMarketMcpEntry(name) {
  const { mcpServers } = await mergedMarketCatalog();
  return mcpServers.find((s) => s.name === name) || null;
}

// Group visibility for market entries: an entry with a non-empty groups[] is
// served only when the user's groups intersect it. No user (auth off) means
// the requester is the machine owner and everything is visible — matching
// requireAdmin's auth-off semantics (a deployment with no identities has no
// one to exclude).
export function visibleToUser(entry, user) {
  if (!Array.isArray(entry.groups) || entry.groups.length === 0) return true;
  if (!user) return true;
  return (user.groups ?? []).some((g) => entry.groups.includes(g));
}

// Clear caches (for testing or when catalog files change)
export function clearMarketCatalogCache() {
  marketCatalogCache = null;
  marketCatalogSkillsCache = null;
}
