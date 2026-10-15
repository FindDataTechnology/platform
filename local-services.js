// ── Headless local-services launcher (dev `npm start`) ───────────────────────
//
// Brings up server.js for non-Electron runs, reusing the SAME shared supervisor
// primitives (supervisor/lifecycle.js) as the desktop Electron app. One
// lifecycle implementation, two entry points.
//
// server.js is pinned to PORT (default 3000) so the Vite dev proxy
// (:5173 -> :3000) and the WS client (ws://localhost:3000) keep working.
//
// LiteLLM and OpenConnector are no longer bundled — dsh's native plugins cover
// LLM routing and SaaS connectors, so server.js is the only child process.
import dotenv from "dotenv";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "./supervisor/lifecycle.js";
import { runFirstRun } from "./bootstrap/first-run.js";

// Load .env with override so PROJECT config wins over inherited shell env.
// (server.js stays no-override: the supervisor injects resolved config into its
// child env directly.)
dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;

// Keys forwarded from .env into the agent env. Mirrors SETTING_KEYS in
// electron/config/settings.js. Keep in sync.
const SETTING_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "DATABASE_URL",
  "DEFAULT_MODEL",
  "AUTH_MODE",
  "PAAS_BASE_URL",
  "SESSION_TTL_HRS",
  "LOGTO_ENDPOINT",
  "LOGTO_APP_ID",
  "LOGTO_APP_SECRET",
  "LOGTO_CLIENT_TYPE",
  "LOGTO_END_SESSION",
  // Search relay (websearch MCP); both set or web_search degrades explicitly.
  "SEARCH_RELAY_URL",
  "SEARCH_RELAY_TOKEN",
];

const DEV_SETTINGS_FILE = "dev-settings.json";

// Is a TCP port free on localhost? (bind + immediately release.)
function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

export async function main() {
  const env = process.env;
  const dataDir = env.PLATFORM_DATA_DIR || PROJECT_ROOT;
  const resourcesDir = path.join(PROJECT_ROOT, "resources");
  const nodeBin = env.PLATFORM_NODE_BIN || process.execPath;

  runFirstRun({
    userDataDir: dataDir,
    resourcesDir,
    defaultSettings: {},
    settingsFileName: DEV_SETTINGS_FILE,
  });

  const agentEnv = {};
  for (const k of SETTING_KEYS) {
    if (env[k] != null && env[k] !== "") agentEnv[k] = String(env[k]);
  }

  // server.js pins to PORT (default 3000) — the Vite dev proxy (:5173 -> :3000)
  // and the WS client (ws://localhost:3000) expect it, so a conflict here is a
  // hard error with a clear message rather than a silent fallback.
  const serverPort = Number(env.PORT) || 3000;
  if (!(await isPortFree(serverPort))) {
    console.error(
      `[local-services] ✖ Port ${serverPort} is already in use. server.js needs it ` +
        `(the Vite dev proxy + WS client expect :3000). Free it, or set PORT=<free> ` +
        `(and update the proxy target in web/vite.config.ts).`
    );
    process.exit(1);
  }

  const supervisor = new Supervisor({
    nodeBin,
    projectRoot: PROJECT_ROOT,
    dataDir,
    agentEnv,
    serverPort,
  });

  // Ordered shutdown on interrupt - the supervisor sets `shuttingDown` so its
  // restart-on-crash logic does not fire during shutdown.
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n[local-services] ${sig} received, shutting down...\n`);
    try {
      await supervisor.stop();
    } catch (e) {
      console.error("[local-services] supervisor stop error:", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await supervisor.start();
  } catch (err) {
    console.warn("[local-services] startup error:", err.message);
  }

  const st = supervisor.status();
  const serverJs = st.find((s) => s.id === "server-js");
  if (!serverJs || serverJs.state !== "healthy") {
    console.error("[local-services] server.js is not healthy; exiting.");
    // Surface the child's recent logs so the cause is visible (e.g. EADDRINUSE,
    // a crash, a missing dependency) instead of a bare "did not become healthy".
    for (const s of st) {
      const lines = (s.logs || []).slice(-12).map((l) => l.line);
      if (lines.length) console.error(`[local-services] ${s.id} logs:\n  ` + lines.join("\n  "));
    }
    try { await supervisor.stop(); } catch { /* swallow */ }
    process.exit(1);
  }

  console.log(`\n[local-services] Platform ready: http://localhost:${supervisor.serverPort}`);
  console.log("\n[local-services] Press Ctrl+C to stop.\n");
}
