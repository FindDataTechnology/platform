// ── Electron main process = supervisor bootstrap ────────────────────────────
//
// Runs NO application logic. Boots the supervisor, waits for the Platform
// backend (server.js) to be healthy, then opens a BrowserWindow pointed at it.
// On quit it tears the servers down in reverse order. The Electron process
// itself never imports server.js or touches native addons (Decisions D1, D4, D8).
//
// Run in dev with:  npm start:electron   (npm run dist builds a distributable)

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config"; // read .env for dev config
import { Supervisor } from "./supervisor/lifecycle.js";
import { registerStatusIpc } from "./supervisor/status.js";
import { resolveEnv } from "./config/settings.js";
import { runFirstRun } from "./bootstrap/first-run.js";
import { openPreferencesWindow, registerPreferencesIpc } from "./preferences/window.js";
import { setSupervisor } from "./preferences/ipc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Packaged GUI processes have no console — every console.* line (boot order,
// supervisor failures, the very reason a window stays black) vanished into
// nowhere, making field reports undebuggable (v1.3.5 black-screen round).
// Mirror them to userData/main.log so "Open Logs Folder" answers everything.
export const MAIN_LOG_PATH = app.isPackaged
  ? path.join(app.getPath("userData"), "main.log")
  : null;
if (MAIN_LOG_PATH) {
  const raw = console.log.bind(console);
  const stamp = (level) => `[${new Date().toISOString()}] [${level}]`;
  const write = (level, args) => {
    try { fs.appendFileSync(MAIN_LOG_PATH, `${stamp(level)} ${args.join(" ")}\n`); } catch { /* disk full etc. — never crash the shell for a log */ }
  };
  console.log = (...a) => { raw(...a); write("info", a); };
  console.warn = (...a) => { write("warn", a); };
  console.error = (...a) => { write("error", a); };
  write("info", [`=== Platform ${app.getVersion()} starting (pid ${process.pid}) ===`]);
}

let supervisor = null;
let mainWindow = null;
let stopping = false;

const gotLock = app.requestSingleInstanceLock();
console.log("[electron] main loaded, lock=", gotLock, "packaged=", app.isPackaged);
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot).catch((err) => {
    console.error("[electron] boot failed:", err);
    openErrorWindow(`Failed to start: ${err && err.message ? err.message : err}`);
  });

  // The window IS the app - closing it stops the backend and quits.
  app.on("window-all-closed", () => { app.quit(); });

  app.on("before-quit", async (event) => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    try { if (supervisor) await supervisor.stop(); }
    catch (e) { console.error("[electron] supervisor stop error:", e); }
    app.quit();
  });
}

async function boot() {
  // Packaged: stores + SQLite land in userData (read-only app bundle); the
  // bundled standalone Node runs the child servers (native-addon ABI match).
  // Dev: stores stay in the project dir; system `node` runs children.
  const dataDir = app.isPackaged ? app.getPath("userData") : (process.env.PLATFORM_DATA_DIR || "");
  const nodeBin = app.isPackaged
    ? path.join(process.resourcesPath, "node", ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]))
    : (process.env.PLATFORM_NODE_BIN || "node");
  const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(PROJECT_ROOT, "resources");

  // Run first-run bootstrap before supervisor starts
  // Idempotent: only seeds missing files/tokens
  const baseEnv = resolveEnv();
  let defaultVolcesKey = {};
  // Placeholder so the preferences UI shows a value; NOT a working key. server.js
  // ships no baked fallback — provision a real Volces key via settings.json.
  if (!baseEnv.LLM_API_KEY) {
    defaultVolcesKey = { LLM_API_KEY: "sk-xxx-baked-fallback" };
  }
  const desktopDefaults = app.isPackaged ? {
    AUTH_MODE: "logto",
    LOGTO_CLIENT_TYPE: "public",
    SESSION_TTL_HRS: "720",
    DESKTOP_SERVER_PORT: "47600",
    // Pin the backend to IPv4 loopback (v1.3.5 black screen): with the
    // "localhost" default, Node on Windows/macOS resolves it to ::1 ONLY —
    // the health probe (same host string) stays green while the window's
    // http://127.0.0.1:<port> hits a closed IPv4 socket, leaving the dark
    // backgroundColor window forever unpainted. agentEnv spreads into the
    // child env AFTER the HOST default, so this wins for the desktop path
    // only; dev (`npm start`) and containers set HOST themselves.
    HOST: "127.0.0.1",
  } : {};
  const boostedSettings = runFirstRun({
    userDataDir: dataDir,
    resourcesDir,
    defaultSettings: { ...defaultVolcesKey, ...desktopDefaults },
  });
  // Merge boosted settings into the resolved env
  const agentEnv = { ...baseEnv, ...boostedSettings };
  // The packaged logto defaults assume settings.json provisioning (README:
  // desktop public client). On a fresh install without a LOGTO_ENDPOINT the
  // logto backend refuses to start (discovery must be reachable) — fall back
  // to open access so the app boots and can be configured, instead of a
  // crash-looping backend behind an error window.
  if (String(agentEnv.AUTH_MODE || "").toLowerCase() === "logto" && !agentEnv.LOGTO_ENDPOINT) {
    console.warn("[electron] AUTH_MODE=logto without LOGTO_ENDPOINT — falling back to open access");
    delete agentEnv.AUTH_MODE;
  }
  const serverPort = agentEnv.DESKTOP_SERVER_PORT ? Number(agentEnv.DESKTOP_SERVER_PORT) : null;

  supervisor = new Supervisor({
    nodeBin,
    projectRoot: PROJECT_ROOT,
    dataDir,
    agentEnv,
    serverPort,
  });
  setSupervisor(supervisor);
  registerStatusIpc(supervisor);
  registerPreferencesIpc(supervisor);
  console.log("[electron] boot: supervisor constructed, starting…");

  // Folder picker for the chat working directory (main window).
  ipcMain.handle("workdir:pick", async () => {
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      message: "Select a working directory",
    });
    return filePaths?.[0] ?? null;
  });

  // Build application menu with Preferences shortcut
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Preferences…",
          accelerator: "Cmd+,",
          click: () => openPreferencesWindow(),
        },
        { type: "separator" },
        // Field-debugging escape hatch (v1.3.5 black-screen round): the log
        // mirror above makes the main process observable on user machines.
        ...(MAIN_LOG_PATH
          ? [{
              label: "Open Logs Folder",
              click: () => { shell.showItemInFolder(MAIN_LOG_PATH); },
            }]
          : []),
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);

  try {
    await supervisor.start();
    const port = supervisor.serverPort;
    if (!port) throw new Error("no server port assigned");
    // 127.0.0.1, not localhost: on Windows the localhost resolution can
    // prefer IPv6 and fall back slowly, stretching the blank-window wait.
    openWindow(`http://127.0.0.1:${port}`);
  } catch (err) {
    console.error("[electron] supervisor start failed:", err);
    openErrorWindow(`Backend failed to start: ${err && err.message ? err.message : err}`);
  }
}

function openWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    backgroundColor: "#0d1117",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "main-preload.js"),
    },
  });
  // Paint-once-then-show: a dark backgroundColor window shown before the page
  // paints reads as a BLACK screen (v1.3.5 field report). Show on first
  // successful paint; a bounded retry loop covers a load racing the backend
  // (first boot can take seconds between listen and full serve).
  let retries = 0;
  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow.isVisible()) mainWindow.show();
  });
  // Safety net: never leave the app windowless — if neither finish nor fail
  // fires within 10s (a hung load), show whatever is there.
  setTimeout(() => { if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show(); }, 10_000);
  mainWindow.webContents.on("did-fail-load", (_event, code, desc, failedUrl) => {
    if (code === -3) return; // ERR_ABORTED — a navigation superseded this one
    retries += 1;
    if (retries > 20) {
      console.error(`[electron] window load failed 20× (last: ${code} ${desc} ${failedUrl}) — giving up`);
      return;
    }
    setTimeout(() => { if (!mainWindow.isDestroyed()) mainWindow.loadURL(url); }, 1000);
  });
  mainWindow.loadURL(url);
  mainWindow.on("closed", () => { mainWindow = null; });
  // Open external http(s) links (e.g. the LiteLLM management dashboard at
  // http://localhost:<port>/ui) in the user's default browser instead of a new
  // Electron window, so target="_blank" links work in the packaged app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
}

function openErrorWindow(message) {
  mainWindow = new BrowserWindow({ width: 640, height: 320 });
  mainWindow.loadURL(
    "data:text/html," +
      encodeURIComponent(
        `<body style="font-family:system-ui;padding:24px;background:#1b1f23;color:#e6edf3;margin:0">` +
          `<h2 style="margin-top:0">Platform failed to start</h2>` +
          `<pre style="white-space:pre-wrap;word-break:break-word">${String(message).replace(/</g, "&lt;")}</pre>` +
          `</body>`
      )
  );
  mainWindow.on("closed", () => { mainWindow = null; });
}
