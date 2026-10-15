// ── Preferences window singleton ─────────────────────────────────────────────
//
// Opens the Preferences window as a singleton (only one open at a time).

import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { readSettings, writeSettings } from "../config/settings.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

let preferencesWindow = null;

export function openPreferencesWindow() {
  if (preferencesWindow !== null) {
    preferencesWindow.focus();
    return;
  }

  preferencesWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: "Preferences — Platform",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  preferencesWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  preferencesWindow.on("closed", () => {
    preferencesWindow = null;
  });
}

// IPC handlers registered once when the app starts
export function registerPreferencesIpc(supervisor) {
  // Allow only these keys to be read/written. The Wanxing registry token is
  // read-masked (see get-visible below) — the raw secret never echoes back to
  // the renderer, matching the platform's "tokens never reach the browser"
  // rule; an overwrite requires re-typing the value.
  const ALLOWED_VISIBLE_KEYS = [
    "LLM_API_KEY", "LLM_BASE_URL", "DEFAULT_MODEL",
    "WANXING_PLUGIN_ENABLED", "AGENT_SERVING_REGISTRY_URL", "AGENT_RUNNER_PORT",
    "AGENT_RUNNER_FLEET_URL",
  ];
  const ALLOWED_WRITE_KEYS = [
    "LLM_API_KEY", "LLM_BASE_URL", "DEFAULT_MODEL",
    "WANXING_PLUGIN_ENABLED", "AGENT_SERVING_REGISTRY_URL",
    "AGENT_SERVING_REGISTRY_TOKEN", "AGENT_RUNNER_PORT",
    "AGENT_RUNNER_FLEET_URL", "AGENT_RUNNER_FLEET_TOKEN",
  ];
  const ALLOWED_SERVICE_RESTART = ["server-js", "agent-runner-js"];
  const MASKED = "••••••••";

  // Get whitelisted visible settings
  ipcMain.handle("settings:get-visible", () => {
    const all = readSettings();
    const visible = {};
    for (const k of ALLOWED_VISIBLE_KEYS) {
      if (k in all) visible[k] = all[k];
    }
    // Secrets: presence, not content (spec: preferences-ui).
    visible.AGENT_SERVING_REGISTRY_TOKEN_SET = Boolean(all.AGENT_SERVING_REGISTRY_TOKEN);
    visible.AGENT_RUNNER_FLEET_TOKEN_SET = Boolean(all.AGENT_RUNNER_FLEET_TOKEN);
    visible.AGENT_SERVING_REGISTRY_TOKEN_MASK = MASKED;
    return visible;
  });

  // Set a single setting field
  ipcMain.handle("settings:set-field", async (_event, { key, value }) => {
    if (!ALLOWED_WRITE_KEYS.includes(key)) {
      return { ok: false, error: "Key not allowed for editing" };
    }
    const current = readSettings();
    current[key] = value;
    writeSettings(current);
    return { ok: true };
  });

  // Restart a service
  ipcMain.handle("service:restart", async (_event, { id }) => {
    if (!ALLOWED_SERVICE_RESTART.includes(id)) {
      return { ok: false, error: "Service not allowed for restart" };
    }
    if (!supervisor) {
      return { ok: false, error: "Supervisor not initialized" };
    }
    const ok = await supervisor.restart(id);
    // If restart fails, get last error and logs
    if (!ok) {
      const status = supervisor.status().find(s => s.id === id);
      return { ok: false, error: status?.lastError || "Restart failed", logs: status?.logs || [] };
    }
    return { ok: true };
  });
}
