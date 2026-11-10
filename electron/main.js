// ── Electron main process = supervisor bootstrap ────────────────────────────
//
// Runs NO application logic. Boots the supervisor, waits for the Platform
// backend (server.js) to be healthy, then opens a BrowserWindow pointed at it.
// On quit it tears the servers down in reverse order. The Electron process
// itself never imports server.js or touches native addons (Decisions D1, D4, D8).
//
// Run in dev with:  npm start:electron   (npm run dist builds a distributable)

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config"; // read .env for dev config
import { Supervisor } from "./supervisor/lifecycle.js";
import { registerStatusIpc } from "./supervisor/status.js";
import { attachSteward } from "../supervisor/steward-client.js";
import { resolveEnv } from "./config/settings.js";
import { registerStewardIpc } from "./steward-ipc.js";
import { runFirstRun } from "./bootstrap/first-run.js";
import { openPreferencesWindow, registerPreferencesIpc } from "./preferences/window.js";
import { createDesktopUpdater } from "./updater.js";
import { registerUpdaterIpc } from "./preferences/update-ipc.js";
import { setSupervisor } from "./preferences/ipc.js";
import { runSmokeSelftest, selftestEnabled } from "./smoke-selftest.js";

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
let tray = null;

// Tray residency (add-desktop-fleet-console): closing the window parks the
// app in the system tray instead of quitting — the fleet runner and its
// scheduled work keep running; only the tray's Quit runs the supervised
// drain. The icon resolves in both layouts (repo build/ in dev, the packaged
// app bundle in production); an unresolvable icon degrades to no tray, and
// without a tray closing the window quits as before (never a zombie app).
function ensureTray() {
  if (tray) return tray;
  const iconCandidates = [
    path.join(PROJECT_ROOT, "build", "icon.png"),
    app.isPackaged ? path.join(process.resourcesPath, "app", "build", "icon.png") : null,
  ].filter(Boolean);
  const iconPath = iconCandidates.find((p) => fs.existsSync(p));
  if (!iconPath) {
    console.warn("[electron] no tray icon found — tray residency disabled, close quits");
    return null;
  }
  const image = nativeImage.createFromPath(iconPath);
  const sized = image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
  tray = new Tray(sized);
  tray.setToolTip(app.name || "Platform");
  const showWindow = () => {
    if (!mainWindow) return openWindow(`http://127.0.0.1:${supervisor?.serverPort || 47600}`);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return undefined;
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => showWindow() },
      { type: "separator" },
      // Quit rides the before-quit handler: supervised drain (fleet runner
      // children included) then app.quit().
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => showWindow());
  console.log("[electron] tray resident (close = park, tray Quit = drain + exit)");
  return tray;
}

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

  // The window is the app's face, not its life: closing it parks the app in
  // the tray (supervisor, chat backend, fleet runner and schedules keep
  // running). With no tray icon available (unexpected layout), closing falls
  // back to quitting so the app can never linger unseen.
  app.on("window-all-closed", () => {
    if (tray) return;
    app.quit();
  });

  app.on("before-quit", async (event) => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    // Attached = resident steward owns the stack: quitting the UI detaches,
    // it never drains (the exit-safety override is the tray Quit → steward's
    // own drainQuit path, driven by policy, not by window lifecycle).
    try { if (supervisor && !supervisor.attached) await supervisor.stop(); }
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
    // The installer's bundled assets (preinstalled starter bundles under
    // resources/bundles) live beside the app bundle, not inside the data
    // root — the cell reads them through this pointer.
    PLATFORM_RESOURCES_DIR: process.resourcesPath,
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

  // Attach-first (add-cell-lifecycle): when a resident steward owns this data
  // root, the app becomes its client — UI exit must NOT drain the runtime.
  // Embedded stays the default world (no steward installed → manual policy).
  // A steward that is registered but won't answer is repaired, never
  // duplicated: two supervisors on one data root is the one topology this
  // mechanism exists to prevent.
  let attached = false;
  if (dataDir) {
    const att = await attachSteward(dataDir).catch(() => ({ ok: false, reason: "attach-error" }));
    if (att.ok) {
      supervisor = {
        attached: true,
        restart: (id) => att.client.request("restart", { id }).then((r) => r?.restarted !== false),
        status: () => att.client.request("status").then((r) => (Array.isArray(r?.servers) ? r.servers : [])),
        // Detach semantics: quitting the UI leaves the resident stack alone.
        stop: async () => {},
        start: () => att.client.request("start"),
        waitForHealthy: async (id, ms = 30000) => {
          const deadline = Date.now() + ms;
          for (;;) {
            const r = await att.client.request("status").catch(() => ({}));
            const s = (r.servers ?? []).find((x) => x.id === id);
            if (s?.state === "healthy") return;
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${id}`);
            await new Promise((r2) => setTimeout(r2, 300));
          }
        },
        get serverPort() { return this._port ?? null; },
        set serverPort(v) { this._port = v; },
      };
      attached = true;
      console.log(`[electron] attached to resident steward (${att.discovery.socket})`);
    } else if (att.reason !== "no-steward-json") {
      const alive = att.discovery?.pid && (() => { try { process.kill(att.discovery.pid, 0); return true; } catch { return false; } })();
      if (alive) {
        console.error(`[electron] steward pid ${att.discovery.pid} alive but socket dead (${att.reason}) — NOT starting a second stack on the same data root; repair via tray/app restart`);
        return openErrorWindow?.(`后台管家进程异常（${att.reason}）。请退出并重新打开应用以修复。`);
      }
      // Stale discovery from a dead steward: clean it and run embedded.
      try { fs.rmSync(path.join(dataDir, "steward.json"), { force: true }); } catch { /* best-effort */ }
      console.warn(`[electron] stale steward discovery removed (${att.reason}) — embedded fallback`);
    }
  }

  if (!supervisor) {
    supervisor = new Supervisor({
      nodeBin,
      projectRoot: PROJECT_ROOT,
      dataDir,
      agentEnv,
      serverPort,
    });
  }
  setSupervisor(supervisor);
  registerStatusIpc(supervisor);
  registerPreferencesIpc(supervisor);
  registerStewardIpc({ dataDir, nodeBin, projectRoot: PROJECT_ROOT, isPackaged: app.isPackaged });
  // In-app update lifecycle (add-desktop-in-app-update): delayed silent check
  // after boot, manual entry + state face in the preferences window. Signed
  // mac builds may flip autoUpdateSupported on later — unsigned stays notify-only.
  const updater = createDesktopUpdater({ signed: Boolean(process.env.DESKTOP_SIGNED) });
  registerUpdaterIpc(updater);
  updater.scheduleBootCheck();
  console.log(`[electron] boot: supervisor ${attached ? "ATTACHED to steward" : "constructed embedded"}, starting…`);

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
    // Attached mode: the steward-supervised port rides the status rows, not a
    // property set by this process's constructor.
    let port = supervisor.serverPort;
    if (attached && !port) {
      const rows = await supervisor.status().catch(() => []);
      port = rows.find((r) => r.id === "server-js")?.port ?? null;
      supervisor.serverPort = port;
    }
    if (!port) throw new Error("no server port assigned");
    // Tray parks the app on window close (spec: desktop-fleet-console).
    ensureTray();
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
  // CI self-test (PLATFORM_SMOKE_SELFTEST): the app testifies about its own
  // rendering — the only check that can catch a black screen (see
  // smoke-selftest.js for why external screenshots cannot).
  if (selftestEnabled()) {
    mainWindow.webContents.once("did-finish-load", async () => {
      const report = await runSmokeSelftest(mainWindow);
      console.log(`[smoke-selftest] ${JSON.stringify(report)}`);
      setTimeout(() => app.exit(report.ok ? 0 : 1), 500);
    });
  }
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
