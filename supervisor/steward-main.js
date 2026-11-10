// Standalone resident entry: `node supervisor/steward-main.js`
//
// The process the per-user autostart launches (macOS LaunchAgent / Windows
// Scheduled Task). Resolves the same inputs electron/main.js resolves — data
// root per-OS, bundled node for children when packaged — constructs the SAME
// Supervisor and hangs the steward control plane on it. Chapter 2 adds the
// autostart registration and the policy engine; this entry is deliberately
// thin so both chapters ride one host.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Supervisor } from "./lifecycle.js";
import { createSteward } from "./steward.js";
import { createPolicyEngine } from "./steward-policy.js";
import { CRASH_DEFAULTS, createCrashGuard } from "./steward-health.js";
import { SETTING_KEYS } from "../lib/settings-keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function defaultDataDir() {
  if (process.env.PLATFORM_DATA_DIR) return process.env.PLATFORM_DATA_DIR;
  const name = process.env.STEWARD_APP_NAME || "platform";
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", name);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name);
  return path.join(os.homedir(), ".config", name);
}

const dataDir = defaultDataDir();
// launchd/schtasks give the resident steward a bare PATH (no "node" on it):
// falling back to `"node"` here spawned every child service into
// "command not found" restart loops on real installs (v1.3.19 first-trial).
// The steward itself already runs under the bundled node (packaged) whose
// ABI matches the children's native addons — reuse that binary by default.
const nodeBin = process.env.PLATFORM_NODE_BIN || process.execPath;

// Orphaned-steward self-clean (add-cell-lifecycle 2.1): on macOS a
// drag-deleted .app runs no uninstaller, so the LaunchAgent would respawn a
// steward whose bundle is gone forever. Detect "packaged entry inside a
// removed .app" and deregister ourselves — the platform registry row then
// reads `destroyed`/tombstoned by staleness (chapter 4).
{
  const inBundle = PROJECT_ROOT.split(path.sep).some((seg) => seg.endsWith(".app"));
  const bundleRoot = PROJECT_ROOT.slice(0, PROJECT_ROOT.indexOf(".app") + 4);
  if (inBundle && !fs.existsSync(bundleRoot)) {
    console.error(`[steward] app bundle gone (${bundleRoot}) — self-deregistering launch agent and exiting`);
    try {
      const { execFile } = await import("node:child_process");
      const uid = String(process.getuid?.() ?? "");
      execFile("launchctl", ["bootout", `gui/${uid}`, path.join(os.homedir(), "Library", "LaunchAgents", `com.earendil.${(process.env.STEWARD_APP_NAME || "platform")}.steward.plist`)], () => {});
      fs.rmSync(path.join(os.homedir(), "Library", "LaunchAgents", `com.earendil.${(process.env.STEWARD_APP_NAME || "platform")}.steward.plist`), { force: true });
    } catch { /* best-effort */ }
    process.exit(0);
  }
}

// Mirror the Electron desktop's loopback pin: descriptors default HOST to
// "localhost", which on this Mac resolves to ::1 first — the child then binds
// IPv6 loopback only, the attached UI's http://127.0.0.1:<port> load spins on
// ERR_CONNECTION_REFUSED, and the supervisor's own localhost probe reports
// healthy (a textbook fake-green). An explicit env HOST still wins.
// The installer's bundled assets (preinstalled starter bundles) sit beside
// the app bundle: <resources>/app/… → <resources>. The pointer lets the cell
// find them in the resident world too, where nobody typed a path.
const resourcesDir =
  process.env.PLATFORM_RESOURCES_DIR ||
  (PROJECT_ROOT.split(path.sep).some((seg) => seg.endsWith(".app")) ? path.resolve(PROJECT_ROOT, "..") : "");

// The resident world must see the SAME settings the desktop app sees.
// launchd/schtasks start this process with a BARE environment (no .env, no
// inherited app env), so without this merge the cell and the runner it
// spawns would miss every user-level key — the fleet plugin switch, the
// local feed bearer, the LLM credentials. The Electron path gets them from
// electron/config/settings.js#resolveEnv; the resident path gets them from
// the same settings.json, read here. The key list is SHARED
// (lib/settings-keys.js) — the guard test refuses a second copy.

function readSettingsEnv() {
  const file = path.join(dataDir, "settings.json");
  let doc = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const out = {};
  for (const key of SETTING_KEYS) {
    const value = doc[key] ?? process.env[key];
    if (value != null && value !== "") out[key] = String(value);
  }
  return out;
}

const settingsEnv = readSettingsEnv();
if (Object.keys(settingsEnv).length === 0) {
  console.warn(`[steward] no settings.json under ${dataDir} — the resident stack runs on defaults`);
}
const agentEnv = {
  ...process.env,
  HOST: process.env.HOST || "127.0.0.1",
  ...settingsEnv,
  ...(resourcesDir ? { PLATFORM_RESOURCES_DIR: resourcesDir } : {}),
};
const supervisor = new Supervisor({ nodeBin, projectRoot: PROJECT_ROOT, dataDir, agentEnv });
const steward = createSteward({ supervisor, dataDir });

// Residency policy engine (chapter 2): always keeps the stack up; on_demand
// wakes on due schedules from jobs.json and drains on quiet; manual stays
// dark. The engine is constructed before listen so every client activity is
// visible to the quiet-drain decision.
const engine = createPolicyEngine({ supervisor, steward, dataDir });
steward.setPolicyEngine(engine);

// Crash-loop guard (add-desktop-residency-hardening 2.x): the OS respawns
// this process unconditionally, so a broken build would loop forever without
// saying anything. The guard counts failed boots, opens a cooldown once the
// threshold is reached (the stack stays DARK and the failure is reported
// instead of hidden), and clears on a healthy boot.
const crashGuard = createCrashGuard({
  dataDir,
  threshold: Number(process.env.STEWARD_CRASH_THRESHOLD) || CRASH_DEFAULTS.threshold,
  cooldownMs: Number(process.env.STEWARD_CRASH_COOLDOWN_MS) || CRASH_DEFAULTS.cooldownMs,
  resetMs: Number(process.env.STEWARD_CRASH_RESET_MS) || CRASH_DEFAULTS.resetMs,
});

const gate = crashGuard.recordStart();
if (!gate.allowed) {
  // Stay alive WITHOUT starting the stack: the OS has nothing to respawn, so
  // the loop stops, and the reason stays visible in the status surface.
  console.error(
    `[steward] boot suppressed by the crash guard (${gate.status.failures} failed boots, retry in ${Math.ceil(gate.retryAfterMs / 1000)}s): ${gate.status.lastFailure?.message ?? "unknown"}`,
  );
  const retry = setTimeout(() => {
    // The window elapsed: leave with a non-zero code so the registration
    // restarts us — the next attempt is a fresh one (the counter was reset by
    // the cooldown, per the guard's contract).
    console.warn("[steward] cooldown elapsed — exiting so the registration retries the boot");
    process.exit(75); // EX_TEMPFAIL
  }, Math.max(1000, gate.retryAfterMs));
  retry.unref?.();
  // Stay resident (unref'd timer + an open handle) until the window ends.
  setInterval(() => {}, 60_000);
} else {
  try {
    const info = await steward.start();
    console.log(`[steward] control plane on ${info.socket} (protocolVersion ${info.protocolVersion})`);

    engine.start();
    // The stack is up: clear the failure history (a healthy boot proves the
    // build works again) and re-arm the uptime-based reset.
    crashGuard.recordHealthy();
    const uptimeTimer = setInterval(() => crashGuard.maybeResetByUptime(), 60_000);
    uptimeTimer.unref?.();

    const quit = async (code = 0) => {
      await steward.shutdown({ removeDiscovery: true });
      process.exit(code);
    };
    process.on("SIGTERM", () => void quit(0));
    process.on("SIGINT", () => void quit(0));
  } catch (err) {
    // A failed boot counts against the guard: the next respawn is the second
    // strike, and the third opens the cooldown.
    crashGuard.recordFailure(err?.message || err);
    console.error("[steward] boot failed:", err?.message || err);
    process.exit(1);
  }
}
