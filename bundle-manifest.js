// ── Bundle manifest: single source of truth for packaging-time selection ─────
//
// `platform.bundle.json` (repo root, shipped inside the packaged app) declares:
//   - mcpServers:   MCP servers pre-installed at first run (origin "bundled")
//   - skills:       names of skills/ entries marked as bundled at first run
//   - permissions:  per-extension policy keyed "mcp:<name>" / "skill:<name>"
//                   ({ allow?, deny?, locked? }) — stored now, enforced by the
//                   extension-tool-permissions change.
//
// Every consumer resolves through resolveBundle() — nobody else parses the JSON.
// OpenConnector/LiteLLM/Postgres removed — dsh's native plugins cover LLM
// routing and SaaS connectors, so there are no heavyweight bundled services.
//
// Error model: resolveBundle() THROWS BundleManifestError on an invalid manifest.
// Runtime callers use resolveBundleSafe(), which falls back to DEFAULTS with a
// warning so a corrupt manifest never prevents the app from starting.

import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FILENAME = "platform.bundle.json";

const PERMISSION_KEY_RE = /^(mcp|skill):[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const DEFAULTS = Object.freeze({
  mcpServers: Object.freeze({}),
  skills: Object.freeze([]),
  permissions: Object.freeze({}),
});

export class BundleManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BundleManifestError";
  }
}

function fail(msg) {
  throw new BundleManifestError(`platform.bundle.json: ${msg}`);
}

function validateMcpServers(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail('"mcpServers" must be an object');
  for (const [name, cfg] of Object.entries(raw)) {
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) fail(`mcpServers."${name}" must be an object`);
    const isStdio = typeof cfg.command === "string";
    const isHttp = typeof cfg.url === "string";
    if (!isStdio && !isHttp) fail(`mcpServers."${name}" needs a "command" (stdio) or "url" (http)`);
    if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") fail(`mcpServers."${name}".enabled must be a boolean`);
  }
  return raw;
}

function validateSkills(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) fail('"skills" must be an array of skill-name strings');
  return raw;
}

function validatePermissions(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail('"permissions" must be an object');
  for (const [key, policy] of Object.entries(raw)) {
    if (!PERMISSION_KEY_RE.test(key)) fail(`permissions key "${key}" must look like "mcp:<name>" or "skill:<name>"`);
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) fail(`permissions."${key}" must be an object`);
    for (const list of ["allow", "deny"]) {
      if (policy[list] !== undefined && (!Array.isArray(policy[list]) || policy[list].some((g) => typeof g !== "string"))) {
        fail(`permissions."${key}".${list} must be an array of tool-name globs`);
      }
    }
    if (policy.locked !== undefined && typeof policy.locked !== "boolean") fail(`permissions."${key}".locked must be a boolean`);
  }
  return raw;
}

/**
 * Resolve the bundle manifest. Throws BundleManifestError on invalid input.
 * @param {Object} opts
 * @param {string} [opts.projectRoot] - dir containing platform.bundle.json (defaults to repo root)
 * @returns {{ mcpServers: Object, skills: string[], permissions: Object,
 *            manifestPath: string, manifestPresent: boolean}}
 */
export function resolveBundle({ projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname)) } = {}) {
  const manifestPath = path.join(projectRoot, MANIFEST_FILENAME);
  let raw = {};
  let manifestPresent = false;
  if (fs.existsSync(manifestPath)) {
    manifestPresent = true;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      fail(`invalid JSON — ${err.message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("top level must be an object");
    for (const key of Object.keys(parsed)) {
      if (!["mcpServers", "skills", "permissions"].includes(key)) fail(`unknown top-level key "${key}"`);
    }
    raw = parsed;
  }

  const mcpServers = validateMcpServers(raw.mcpServers);
  const skills = validateSkills(raw.skills);
  const permissions = validatePermissions(raw.permissions);

  return { mcpServers, skills, permissions, manifestPath, manifestPresent };
}

/**
 * Runtime-safe variant: on ANY manifest error, log a clear warning and return
 * defaults. Never throws.
 */
export function resolveBundleSafe({ env = process.env, projectRoot, log = console.warn } = {}) {
  try {
    return resolveBundle({ ...(projectRoot ? { projectRoot } : {}) });
  } catch (err) {
    log(`[bundle] ${err.message} — falling back to defaults`);
    return {
      mcpServers: {},
      skills: [],
      permissions: {},
      manifestPath: projectRoot ? path.join(projectRoot, MANIFEST_FILENAME) : MANIFEST_FILENAME,
      manifestPresent: false,
    };
  }
}