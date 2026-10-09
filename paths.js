// ── Store path resolution ───────────────────────────────────────────────────
//
// Centralizes where on-disk state lives. In dev (`npm start`) PLATFORM_DATA_DIR
// is unset and each store keeps its historical relative location (relative to
// CWD). When packaged as an Electron app, the supervisor sets PLATFORM_DATA_DIR
// to app.getPath('userData') so all writable state lands in a per-user,
// update-safe, writable directory - the macOS app bundle itself is read-only.
//
// A module-specific override (an absolute path) always wins over
// PLATFORM_DATA_DIR, preserving the existing DB_PATH / SESSIONS_STORE_DIR /
// CRON_STORAGE_PATH env vars used in dev and tests.

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PLATFORM_DATA_DIR = process.env.PLATFORM_DATA_DIR || "";

// The application's own root, resolved from THIS module's location. Hosted
// cells run with a per-user cwd (tenant-cell-runtime), so bundled read-only
// assets — skills/, web/dist, the catalog JSONs — must never depend on where
// the process happens to sit.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".");

// Resolve a bundled (image-shipped, read-only) asset under the app root.
export function repoRoot(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

// Bundled JSON with an operator-override twist: these files historically
// resolve from CWD — which is how a deployment overlays a local copy (the demo
// pod's agents.json configmap mount, test fixtures via chdir). Cells run in a
// per-user cwd where no copy exists, so the repo copy is the effective
// default; a cwd copy, when present, still wins.
export function bundledJson(name) {
  const local = path.resolve(name);
  return existsSync(local) ? local : repoRoot(name);
}

// Resolve a store directory. `override` (from a module-specific env var) wins;
// otherwise the store lands under PLATFORM_DATA_DIR/<subdir> when packaged, or
// <subdir> relative to CWD in dev.
export function storeDir(subdir, override) {
  if (override) return path.resolve(override);
  if (PLATFORM_DATA_DIR) return path.join(PLATFORM_DATA_DIR, subdir);
  return path.resolve(subdir);
}
