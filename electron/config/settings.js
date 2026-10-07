// ── User settings (packaged-mode config) ────────────────────────────────────
//
// In dev, backend config (LLM keys, service URLs) comes from `.env` (loaded by
// dotenv in both server.js and main.js). End users of the packaged app cannot
// edit `.env` inside the bundle, so the same knobs are exposed via a JSON file
// in app.getPath('userData'). Settings.json takes precedence over inherited
// env, so a packaged install with a settings file overrides anything inherited.
//
// The supervisor reads these and injects them into the server.js child's env
// (Decision D7). Tokens stay in the main process / child env - never in the
// renderer - preserving the project's "tokens never reach the browser" rule.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const SETTING_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "DEFAULT_MODEL",
  "AUTH_MODE",
  "LOGTO_ENDPOINT",
  "LOGTO_APP_ID",
  "LOGTO_CLIENT_TYPE",
  "SESSION_TTL_HRS",
  "DESKTOP_SERVER_PORT",
  // Search relay (websearch MCP): both must be set or web_search degrades to
  // an explicit "not configured" tool error.
  "SEARCH_RELAY_URL",
  "SEARCH_RELAY_TOKEN",
];

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeSettings(obj) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(obj, null, 2));
}

// Resolve the backend env: settings.json wins, then process.env (carries .env
// values in dev). Empty values are dropped so server.js falls back to its own
// defaults / graceful-degradation paths.
export function resolveEnv() {
  const s = readSettings();
  const out = {};
  for (const k of SETTING_KEYS) {
    const v = s[k] ?? process.env[k];
    if (v != null && v !== "") out[k] = String(v);
  }
  return out;
}
