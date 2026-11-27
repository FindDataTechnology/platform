// ── Desktop updater shell (add-desktop-in-app-update) ────────────────────────
//
// The electron-bound half of the in-app update lifecycle. Core decisions live
// in updater-core.js (testable without electron); this shell owns:
//   - the electron-updater client on Windows (generic provider, background
//     download, install on quit — a live session is never interrupted);
//   - the notify-only degrade on unsigned macOS (fetch latest-mac.yml, compare,
//     surface the checksummed dmg URL — Gatekeeper refuses unsigned swaps);
//   - the state face for the preferences renderer
//     (idle|checking|downloading|downloaded|up-to-date|notify-only|error + info).
//
// Channel: DESKTOP_UPDATE_URL in settings.json (editable in preferences),
// falling back to updater-core's built-in default — read at CHECK time, so a
// lane change never needs a restart.

import { app, shell } from "electron";
import { writeFileSync } from "node:fs";
// electron-updater is CJS whose exports are attached through TS's
// __exportStar/getter machinery — cjs-module-lexer cannot see them, so a
// NAMED import (`import { autoUpdater } from "electron-updater"`) throws
// SyntaxError at link time and kills the packaged app's whole import graph
// (five E2E rounds of total silence; local repro: node --input-type=module).
// The default export IS module.exports for CJS — destructure from it.
import electronUpdater from "electron-updater";
import { readSettings } from "./config/settings.js";
import { autoUpdateSupported, macNotifyCheck, DEFAULT_UPDATE_URL } from "./updater-core.js";

const { autoUpdater } = electronUpdater;

const CHECK_DELAY_MS = 15_000; // boot settles first; the check never blocks startup

// E2E instrumentation (desktop-update-e2e round 4): this mirror is written at
// MODULE SCOPE — main.js statically imports this file, so the write happens
// the moment the packaged app's main process loads its entry graph, BEFORE
// whenReady/boot. A missing file therefore means the app never ran the bundle
// (packaging/launch problem); a file stuck at "module-loaded" means boot threw
// or blocked before reaching createDesktopUpdater(). Rounds 1-3 could not tell
// these apart because the write lived inside the factory.
if (process.env.UPDATER_STATE_FILE) {
  try {
    writeFileSync(process.env.UPDATER_STATE_FILE, JSON.stringify({ status: "module-loaded", at: Date.now() }));
  } catch { /* instrumentation never breaks the updater */ }
}

export function createDesktopUpdater({ platform = process.platform, signed = false, log = console } = {}) {
  const state = {
    status: "idle", // idle|checking|downloading|downloaded|up-to-date|notify-only|error
    version: null,
    url: null,
    error: null,
    checkedAt: null,
  };
  const listeners = new Set();
  let wired = false;

  const setState = (patch) => {
    Object.assign(state, patch, { checkedAt: Date.now(), runningVersion: app.getVersion() });
    // E2E instrumentation (desktop-update-e2e): env-gated state mirror — the
    // Windows GUI process detaches from stdout, so the test polls this file.
    if (process.env.UPDATER_STATE_FILE) {
      try {
        writeFileSync(process.env.UPDATER_STATE_FILE, JSON.stringify(state));
      } catch { /* instrumentation must never break the updater */ }
    }
    for (const fn of listeners) {
      try {
        fn({ ...state });
      } catch { /* a dead renderer never breaks the updater */ }
    }
  };

  const channelUrl = () => {
    try {
      return readSettings().DESKTOP_UPDATE_URL || DEFAULT_UPDATE_URL;
    } catch {
      return DEFAULT_UPDATE_URL;
    }
  };

  // electron-updater's events are the source of truth past `checking`; every
  // path lands in a named state, errors included (the preferences face shows
  // them; a boot-time check never pops a dialog — spec: 静默降级).
  function wireAutoUpdater() {
    if (wired) return;
    wired = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // the default posture: install when the user quits
    autoUpdater.on("update-available", (info) => setState({ status: "downloading", version: info?.version ?? null, error: null }));
    autoUpdater.on("download-progress", () => setState({ status: "downloading" }));
    autoUpdater.on("update-downloaded", (info) => setState({ status: "downloaded", version: info?.version ?? null }));
    autoUpdater.on("update-not-available", (info) => setState({ status: "up-to-date", version: info?.version ?? null, error: null }));
    autoUpdater.on("error", (err) => {
      log.warn(`[updater] ${err?.message || err}`);
      setState({ status: "error", error: String(err?.message || err) });
    });
  }

  async function check() {
    if (platform !== "win32" && platform !== "darwin") {
      setState({ status: "error", error: `unsupported platform ${platform}` });
      return { ...state };
    }
    setState({ status: "checking", error: null });
    if (autoUpdateSupported({ platform, signed })) {
      wireAutoUpdater();
      try {
        autoUpdater.setFeedURL({ provider: "generic", url: channelUrl() });
        autoUpdater.checkForUpdates().catch((err) => {
          log.warn(`[updater] check failed: ${err?.message || err}`);
          setState({ status: "error", error: String(err?.message || err) });
        });
      } catch (err) {
        setState({ status: "error", error: String(err?.message || err) });
      }
      // `checking` now; update-not-available / update-downloaded / error take
      // it from here through the wired events.
      return { ...state };
    }
    // macOS unsigned (or any non-autoUpdate platform): notify-only.
    const mac = await macNotifyCheck({ channelUrl: channelUrl(), currentVersion: app.getVersion(), fetchImpl: fetch });
    if (!mac) {
      setState({ status: "error", error: "release lane unreachable" });
      return { ...state };
    }
    setState({
      status: mac.available ? "notify-only" : "up-to-date",
      version: mac.version,
      url: mac.url,
      error: null,
    });
    if (mac.available) log.log(`[updater] mac notify-only: ${mac.version} at ${mac.url}`);
    return { ...state };
  }

  return {
    // Boot-time delayed silent check (spec: 不阻塞启动、失败静默).
    scheduleBootCheck() {
      const t = setTimeout(() => {
        check().catch((e) => log.warn(`[updater] boot check failed: ${e?.message || e}`));
      }, CHECK_DELAY_MS);
      if (typeof t.unref === "function") t.unref();
    },
    check,
    getState: () => ({ ...state, runningVersion: app.getVersion() }),
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Preferences entry: only an explicit user action quits and installs.
    quitAndInstall() {
      if (state.status !== "downloaded") return false;
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
      return true;
    },
    async openDownload() {
      if (!state.url) return false;
      await shell.openExternal(state.url);
      return true;
    },
  };
}
