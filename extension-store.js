// extension-store.js
// Business logic layer for managing MCP server configs and custom skills.
// Wraps the db.js CRUD operations and provides market catalog loading.

import { bundledJson } from "./paths.js";
import { readJsonOr } from "./lib/persistence.js";
import * as db from "./db.js";
import { getMarketEntries, getCatalogSource } from "./registry-bridge.js";
import { projectAnnotation } from "./lib/supply-annotations.js";
import { getRepoSkillAnnotation } from "./lib/market-annotations.js";
import { getFileSkills } from "./server/skills.js";

// Resolved at READ time — see catalog.js: a cwd overlay may land after boot.
// The starter floor is app-shipped product content (stdio servers + built-in
// skills), appended to every served market; the catalog copy is a GENERATED
// offline snapshot of the unified supply catalog (add-supply-catalog-unification).
const starterMcpFile = () => bundledJson("market-starters.json");
const starterSkillsFile = () => bundledJson("market-starters-skills.json");
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

// "Same program" = same command + same args, whatever name a manifest gave it.
// The deployment baseline and the packaged bundle disagree on the actions
// bridge's name (`actions` vs `actions-mcp`) while pointing at one script;
// seeding keys on name, so without this a hosted cell ran it twice AND the
// bundle copy named no proposer (2026-11-09 live finding).
export function mcpProgramKey(config) {
  return [config?.command, ...(config?.args ?? [])].join(" ");
}

// Name of an ENABLED row that already runs this program, or null. `excludeName`
// skips the row being (re)seeded; disabled rows do not count, so disabling one
// name can never make the other one disappear too.
export function findSameProgram(rows, config, { excludeName = null } = {}) {
  const want = mcpProgramKey(config);
  if (!want.trim()) return null;
  const hit = rows.find((r) => r.enabled !== false && r.name !== excludeName && mcpProgramKey(r.config) === want);
  return hit?.name ?? null;
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

// The v30 fields (files/frontmatter/originMeta) pass through verbatim when
// present — object in, JSON column storage, object out. Callers that omit
// them (the user-edit path, packs) keep the old single-file behavior.
const SKILL_V30_KEYS = ["files", "frontmatter", "originMeta"];

function pickV30(extra) {
  const out = {};
  for (const k of SKILL_V30_KEYS) if (extra[k] !== undefined) out[k] = extra[k];
  return out;
}

export function addCustomSkill({ name, description, content, enabled = true, ...extra }) {
  return db.addCustomSkill({ name, description, content, enabled, ...pickV30(extra) });
}

export function updateCustomSkill(name, { description, content, enabled, ...extra }) {
  return db.updateCustomSkill(name, { description, content, enabled, ...pickV30(extra) });
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

let starterMcpCache = null;
let starterSkillsCache = null;
let marketCatalogCache = null;
let marketCatalogSkillsCache = null;

export async function loadStarters() {
  if (starterMcpCache) return starterMcpCache;
  const doc = readJsonOr(starterMcpFile(), null, { label: "extensions" });
  starterMcpCache = doc?.mcpServers ?? [];
  return starterMcpCache;
}

export async function loadStarterSkills() {
  if (starterSkillsCache) return starterSkillsCache;
  const doc = readJsonOr(starterSkillsFile(), null, { label: "extensions" });
  starterSkillsCache = doc?.skills ?? [];
  return starterSkillsCache;
}

// The generated offline snapshot (catalog species only) — served when no
// catalog source is configured. Absent/invalid file degrades to empty (the
// starter floor still carries the zero-config trio).
export async function loadMarketCatalog() {
  if (marketCatalogCache) return marketCatalogCache;
  const doc = readJsonOr(marketCatalogFile(), null, { label: "extensions" });
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
  // sort ready-to-use first, then alphabetical. The starter floor's stdio
  // trio surfaces first; gateway entries follow.
  servers.sort((a, b) => {
    if (a.requiresConfig !== b.requiresConfig) return a.requiresConfig ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return {
    mcpServers: servers.filter((s) => visibleToUser(s, user)),
    skills: skills.filter((s) => visibleToUser(s, user)),
  };
}

// The assembled catalog BEFORE per-user visibility filtering — the install
// admission check needs an entry's groups even when the requesting user must
// not see it (that's exactly the bypass it exists to close).
//
// Assembly (add-supply-catalog-unification): the app-shipped starter floor
// plus the catalog species from ONE source — the facet projection / legacy
// registry snapshot when a source is configured, the generated offline
// snapshot when not. No bundled-wins merge: a catalog entry sharing a starter
// name wins (the supply plane is the truth for what a server is); the floor
// and the catalog are disjoint by construction (stdio vs gateway).
async function mergedMarketCatalog() {
  const [starterMcp, starterSkills] = await Promise.all([loadStarters(), loadStarterSkills()]);
  let catalogMcp, catalogSkills;
  if (getCatalogSource() === "none") {
    const [snap, _snapSk] = await Promise.all([loadMarketCatalog(), loadMarketCatalogSkills()]);
    catalogMcp = snap.mcpServers || [];
    catalogSkills = snap.skills || [];
  } else {
    const entries = getMarketEntries();
    catalogMcp = entries.mcpServers;
    catalogSkills = entries.skills;
  }
  const catalogMcpNames = new Set(catalogMcp.map((s) => s.name));
  const catalogSkillNames = new Set(catalogSkills.map((s) => s.name));
  const out = {
    mcpServers: [...starterMcp.filter((s) => !catalogMcpNames.has(s.name)), ...catalogMcp],
    skills: [...starterSkills.filter((s) => !catalogSkillNames.has(s.name)), ...catalogSkills],
  };
  // Normalize the annotation field to `annotation` (singular — the shape the
  // read faces and the install path consume). Bridge entries carry the raw
  // `annotations` object (already merged with the repo annotation source at
  // ingestion); snapshot/starter entries carry `annotation` directly.
  for (const s of out.mcpServers) if (s.annotations && !s.annotation) s.annotation = s.annotations;
  for (const s of out.skills) if (s.annotations && !s.annotation) s.annotation = s.annotations;
  return out;
}

// Annotations keyed by supply-object name (MCP servers + skills) — the read
// faces attach these to INSTALLED rows too (a row's own config store does not
// carry annotations; the catalog is the annotation truth).
export async function getAnnotationsByName() {
  const { mcpServers, skills } = await mergedMarketCatalog();
  const byName = new Map();
  for (const s of mcpServers) if (s.annotation) byName.set(s.name, s.annotation);
  for (const s of skills) if (s.annotation) byName.set(s.name, s.annotation);
  return byName;
}

// Canonical briefs for the runtime tool-description overlay (add-tool-
// description-enrichment): `{ tools: { "<server>__<leaf>": { brief, source,
// updatedAt } } }` from the merged annotations' canonical track. Only CURATED
// briefs contribute — a human-only annotation enriches nothing (the runtime
// side must never see machine-inferred text). Server-level canonical briefs
// have no single tool-face target and stay out of this index.
export async function getCanonicalBriefs() {
  const { mcpServers } = await mergedMarketCatalog();
  const tools = {};
  for (const s of mcpServers) {
    const ann = s.annotation;
    if (!ann) continue;
    const source = ann.provenance?.source ?? null;
    const updatedAt = ann.provenance?.updatedAt ?? null;
    for (const [leaf, toolAnnotation] of Object.entries(ann.tools || {})) {
      const brief = toolAnnotation?.canonical?.brief;
      if (typeof brief !== "string" || !brief.trim()) continue;
      tools[`${s.name}__${leaf}`] = {
        brief,
        source,
        updatedAt: toolAnnotation.provenance?.updatedAt ?? updatedAt,
      };
    }
  }
  return { tools };
}

// Light annotation index for the chat tool blocks (add-mcp-annotation-overlay
// D5): `{ servers: { name: {label, summary} }, tools: { "<server>__<leaf>":
// {label, summary} } }`, projected to `locale` through the ONE projection
// helper (zh 唯一回落). A tool sub-annotation contributes under every server
// that carries it; unannotated entries contribute nothing (raw rendering).
export async function getSupplyAnnotationIndex(locale) {
  const { mcpServers } = await mergedMarketCatalog();
  const servers = {};
  const tools = {};
  for (const s of mcpServers) {
    if (!s.annotation) continue;
    const projected = projectAnnotation(s.annotation, locale);
    if (projected) {
      servers[s.name] = { label: projected.name, summary: projected.summary };
    }
    for (const [leaf, toolAnnotation] of Object.entries(s.annotation.tools || {})) {
      const projectedTool = projectAnnotation(toolAnnotation, locale);
      if (projectedTool) {
        tools[`${s.name}__${leaf}`] = { label: projectedTool.name, summary: projectedTool.summary };
      }
    }
  }
  // add-skill-display-annotations 3.1: skill labels join the index so chat
  // skill blocks render the localized human label beside the slug. File-skill
  // annotations come from the repo annotation source's `skills` key
  // (origin yizuo-file); absent skills render unchanged.
  const skills = {};
  try {
    const fileSkills = getFileSkills();
    for (const s of fileSkills) {
      const repo = getRepoSkillAnnotation(s.name);
      const ann = repo && repo.origin === "yizuo-file" ? projectAnnotation(repo.annotation, locale) : null;
      if (ann) {
        skills[s.name] = { label: ann.name, summary: ann.summary };
      }
    }
  } catch {
    // index unavailable → skill blocks render unchanged (never a throw)
  }
  return { servers, tools, skills };
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
  starterMcpCache = null;
  starterSkillsCache = null;
  marketCatalogCache = null;
  marketCatalogSkillsCache = null;
}
