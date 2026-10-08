// ── First-run bootstrap for bundled services (shared, Electron-agnostic) ──────
//
// Runs before the supervisor starts. Idempotent atomic seeding of
// <dataDir>/<settingsFileName>. All writes are temp+rename so interrupted
// writes leave the filesystem consistent.
//
// Shared by the packaged Electron app (settings.json under userData) and the
// headless local-services launcher (dev-settings.json under PLATFORM_DATA_DIR).
// Takes a `dataDir` + `settingsFileName` instead of app.getPath("userData").
//
// LLM management is now handled natively by dsh-llm (no bundled child
// processes), so this is a thin pass-through that only ensures the settings
// file exists and merges defaults.

import { atomicWriteJsonSync } from "../lib/persistence.js";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} FirstRunOptions
 * @property {string} userDataDir - writable data directory (PLATFORM_DATA_DIR / userData)
 * @property {string} resourcesDir - root of bundled resources (process.resourcesPath when packaged)
 * @property {Object} [defaultSettings] - base default settings (baked Volces key, etc.)
 * @property {string} [settingsFileName] - settings file name within dataDir (default "settings.json")
 */

/**
 * Run first-run bootstrap. Idempotent. Never overwrites existing user files.
 * @param {FirstRunOptions} opts
 * @returns {Object} updated settings
 */
export function runFirstRun(opts) {
  const { userDataDir, defaultSettings = {}, settingsFileName = "settings.json" } = opts;
  console.log("[bootstrap] Running first-run check in", userDataDir);

  // Ensure userDataDir exists
  fs.mkdirSync(userDataDir, { recursive: true });

  // Paths
  const settingsPath = path.join(userDataDir, settingsFileName);

  // Read/parse settings
  let settings = {};
  let settingsExists = false;
  if (fs.existsSync(settingsPath)) {
    settingsExists = true;
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw);
    } catch (err) {
      console.error("[bootstrap] Corrupt settings file, leaving unchanged:", err.message);
      return { ...defaultSettings, ...settings };
    }
  }

  // Merge default settings if missing
  const merged = { ...defaultSettings, ...settings };

  // Write settings atomically if we changed it OR it didn't exist
  if (!settingsExists || Object.keys(settings).length !== Object.keys(merged).length) {
    atomicWriteJsonSync(settingsPath, merged);
    console.log("[bootstrap] Wrote updated", settingsFileName, "to", settingsPath);
  }

  return merged;
}
