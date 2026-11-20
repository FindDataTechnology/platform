// ── Team plugin references (openspec: add-fleet-plugin-declaration) ─────────
//
// A pack may declare which baked dsh plugins its team needs:
//
//   "plugins": [{ "id": "@acme/pdf-kit", "version": "1.2.0" }]
//
// Two rules hold everywhere, and both are checks, not choices:
//
//   · the id must ALREADY be baked into this deployment's roster — a pack
//     reference is a demand, never an install instruction (supply stays an ops
//     decision; runtime download/build/install stays forbidden);
//   · the version is an ASSERTION. The roster carries exactly one baked copy per
//     id, so "mismatch" can only mean a mis-authored declaration or a machine
//     that has not been re-baked. Both need a human; we never pick the nearest
//     version (D4).
//
// This module is pure: the roster and the baked-version map are injected, which
// is what makes the install-face check testable with zero network and zero
// filesystem (the tests stub `net.connect` to prove it).
//
// The publish face uses the shape half only — the publishing machine has no
// roster, and pretending otherwise would make publishing depend on the
// publisher's machine.

/** Keys a reference may not carry: a reference is an id, never a source. */
export const PLUGIN_FORBIDDEN_KEYS = Object.freeze([
  "name",
  "package",
  "packageName",
  "registry",
  "registryName",
  "source",
  "tarball",
  "integrity",
  "path",
  "dir",
  "file",
  "url",
  "endpoint",
  "registryUrl",
  "install",
  "command",
  "args",
  "env",
  "secret",
]);

/** Scoped or bare npm-style name: what the roster actually keys on. */
export const PLUGIN_ID_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Optional exact version. Ranges are refused: there is one baked copy. */
export const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Shape half — shared by the publish gate and the install path.
 * @param {unknown} plugins
 * @param {{ maxPlugins?: number }} [limits]
 * @returns {{error: string, path?: string, code: string}[]}
 */
export function validatePluginsSection(plugins, limits = {}) {
  const max = Number.isInteger(limits.maxPlugins) && limits.maxPlugins > 0 ? limits.maxPlugins : 8;
  if (plugins === undefined || plugins === null) return [];
  if (!Array.isArray(plugins)) {
    return [{ error: "plugins must be an array of { id, version? } references", code: "plugins_not_array" }];
  }
  if (plugins.length > max) {
    return [{ error: `plugins may declare at most ${max} entries`, code: "plugins_too_many" }];
  }

  const errors = [];
  const seen = new Map();
  plugins.forEach((entry, index) => {
    const at = `plugins[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ error: "plugin reference must be an object", path: at, code: "plugin_entry_invalid" });
      return;
    }
    const forbidden = PLUGIN_FORBIDDEN_KEYS.filter((key) => entry[key] !== undefined);
    if (forbidden.length > 0) {
      errors.push({
        error: `plugin references may only name a baked id (found forbidden key(s): ${forbidden.join(", ")}); this deployment never installs from a pack`,
        path: at,
        code: "plugin_forbidden_keys",
      });
      return;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!PLUGIN_ID_RE.test(id)) {
      errors.push({ error: "plugin id must be a package-style name (letters/digits . _ -), 1-64 chars", path: `${at}.id`, code: "plugin_id_invalid" });
      return;
    }
    if (seen.has(id)) {
      errors.push({ error: `plugin '${id}' is declared twice (first at plugins[${seen.get(id)}])`, path: `${at}.id`, code: "plugin_duplicate" });
      return;
    }
    seen.set(id, index);
    if (entry.version !== undefined) {
      if (typeof entry.version !== "string" || !PLUGIN_VERSION_RE.test(entry.version)) {
        errors.push({
          error: "plugin version must be an exact x.y.z version (ranges are refused: the roster has exactly one baked copy)",
          path: `${at}.version`,
          code: "plugin_version_invalid",
        });
      }
    }
  });
  return errors;
}

/**
 * Supply half — install face only, because only a machine with the roster can
 * answer it.
 *
 * @param {{
 *   declared: {id: string, version?: string}[],
 *   roster: {id: string, enabled?: boolean}[],
 *   bakedVersions?: Map<string,string>|Record<string,string>|null
 * }} input
 * @returns {{ missing: string[], mismatches: {id: string, declared: string, baked: string|null}[] }}
 */
export function checkPluginSupply({ declared, roster, bakedVersions = null }) {
  const list = Array.isArray(declared) ? declared : [];
  const available = new Set((Array.isArray(roster) ? roster : []).map((row) => row?.id).filter(Boolean));
  const versionOf = (id) => {
    if (!bakedVersions) return null;
    if (typeof bakedVersions.get === "function") return bakedVersions.get(id) ?? null;
    const value = bakedVersions[id];
    return typeof value === "string" ? value : null;
  };

  const missing = [];
  const mismatches = [];
  for (const entry of list) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (!available.has(id)) {
      // A declared-but-absent plugin is a hard failure: silently installing a
      // pack whose team cannot work is the "装好了但没生效" state this gate
      // exists to prevent.
      missing.push(id);
      continue;
    }
    if (typeof entry.version === "string" && entry.version) {
      const baked = versionOf(id);
      // An unknown baked version is NOT treated as a match: the caller failed
      // to prove supply, and "probably fine" is how the silent state returns.
      if (baked !== entry.version) mismatches.push({ id, declared: entry.version, baked });
    }
  }
  return { missing, mismatches };
}

/** One operator-facing message naming everything that is wrong. */
export function describePluginSupplyFailure({ missing, mismatches }) {
  const parts = [];
  if (missing.length > 0) {
    parts.push(
      `not supplied by this deployment: ${missing.join(", ")} (a pack reference never installs a plugin — bake it into the roster first)`,
    );
  }
  for (const m of mismatches) {
    parts.push(
      m.baked
        ? `plugin '${m.id}' declares version ${m.declared} but this deployment bakes ${m.baked}`
        : `plugin '${m.id}' declares version ${m.declared} but its baked version could not be read`,
    );
  }
  return parts.join("; ");
}

// ── The one I/O in this module ──────────────────────────────────────────────
// Baked versions come from the installed tree, which is the only authority on
// "which copy this machine actually has". Local filesystem reads only — this
// function must never open a socket (the install face runs on cells whose
// network posture is not the point).
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where a deployment's baked copies live, in precedence order. The profile's own
 * node_modules first (a per-cell DSH_HOME links it), then the image-level
 * install tree. Read from env at call time, never snapshotted.
 */
export function defaultBakedRoots(env = process.env) {
  const home = env?.DSH_HOME || path.join(os.homedir(), ".dsh");
  const profile = env?.DSH_PROFILE || "platform";
  return [path.join(home, "profiles", profile, "node_modules"), "/opt/dsh/node_modules"];
}

/**
 * @param {{ roots: string[], ids: string[] }} input  node_modules roots in precedence order
 * @returns {Map<string,string>} id → version, for the ids that could be read
 */
export function readBakedVersions({ roots = [], ids = [] } = {}) {
  const found = new Map();
  for (const id of ids) {
    if (!id) continue;
    for (const root of roots) {
      if (!root) continue;
      try {
        const pkg = JSON.parse(readFileSync(path.join(root, id, "package.json"), "utf8"));
        if (typeof pkg?.version === "string" && pkg.version) {
          found.set(id, pkg.version);
          break;
        }
      } catch {
        // Not in this root; try the next one. Absence is reported by the
        // caller as "could not read", never as a match.
      }
    }
  }
  return found;
}

/** True when nothing is wrong. */
export function pluginSupplyOk(result) {
  return result.missing.length === 0 && result.mismatches.length === 0;
}
