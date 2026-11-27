// server/browser-mcp.js — the browser lane's stdio launcher
// (add-browser-use-lane). A first-party thin process (the websearch-mcp
// precedent) that execs the PINNED @playwright/mcp CLI so the lane's version
// and flags are deployment facts, not npx resolution at call time:
//
//   local   BROWSER_RUNTIME_PATH supplies a chromium install; the CLI launches
//           its own headless browser (default).
//   remote  BROWSER_CDP_ENDPOINT points at an existing browser; the CLI attaches
//           (no local runtime needed).
//   absent  the supply gate in dsh-profile.js omits the entry entirely — this
//           launcher is never spawned. If it is spawned anyway (an operator
//           added the entry BY HAND through the extension API), it fails loudly
//           on stdio-adjacent stderr so the MCP client's degrade path shows the
//           reason instead of a silent dead tool surface.
//
// Shape note (slim-browser-lane-footprint): this shim is the PER-CELL shape. On
// a pod that sets BROWSER_SHARED_MCP_URL, dsh-profile.js writes a
// streamable-http entry instead and this file is never spawned — the shared
// service (server/browser-lane-service.js) holds one CLI for the whole pod. The
// shim stays as the desktop/single-process shape and as the rollback face (drop
// the env, next patch write goes back to per-cell processes).
//
// Env contract (see .env.example):
//   BROWSER_MCP_CLI        absolute path to @playwright/mcp's cli.js (image
//                          bakes /opt/browser-mcp/...; desktop opt-in sets it)
//   BROWSER_CDP_ENDPOINT   attach to this browser instead of launching
//   BROWSER_HEADLESS       "0" launches headful (desktop local use)
//   BROWSER_LANE           "off" is honored by the gate, not here
//
// stdout belongs to the MCP protocol: every diagnostic goes to stderr.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveBrowserLaunchConfig } from "../lib/browser-runtime.js";

// Output dir (resource-library walkthrough defect, 2026-10-28): by default
// @playwright/mcp writes screenshots/downloads under os.tmpdir()/.playwright-mcp,
// outside the user's workspace — so the cell's file-capture hook rejected them
// with invalid_path (and the agent's artifacts can't be served via /api/files
// or offered as save-to-library). Point the lane's outputs at the workspace:
// explicit BROWSER_OUTPUT_DIR wins, else the AGENT_WORKSPACE pin the deployment
// sets, else this process's own cwd (a dsh-mcp-client child launches in the
// session's validated workspace).
// Resolve an output dir, or leave it UNSET: the CLI's own default (a writable
// temp dir) beats a cwd that may be a read-only /app — an early version fell
// back to process.cwd() and the image smoke died with "EACCES: open
// '/app/page-….yml'" (2026-10-28). The platform injects BROWSER_OUTPUT_DIR =
// the session workspace per cell (dsh-profile lane entry), which is the only
// value that routes artifacts into the user's workspace for resource capture.
//
// It must configure BOTH channels, learned the hard way in the image smoke:
//   - config `outputDir`     → auto page snapshots / downloads
//   - the CLI's process CWD  → `browser_take_screenshot`'s filename, which the
//                              CLI resolves relative to its own cwd ("EACCES:
//                              open '/app/browser-lane-smoke.png'" in CI, where
//                              cwd=/app is read-only)
const laneOutputDir =
  (process.env.BROWSER_OUTPUT_DIR || "").trim() || (process.env.AGENT_WORKSPACE || "").trim();

const { cli, config: browserConfig, error } = resolveBrowserLaunchConfig({
  env: process.env,
  outputDir: laneOutputDir,
});
if (error) {
  console.error(`[browser-mcp] ${error}`);
  process.exit(1);
}

const configDir = mkdtempSync(join(tmpdir(), "browser-mcp-"));
const configPath = join(configDir, "config.json");
writeFileSync(configPath, JSON.stringify(browserConfig));
const args = ["--config", configPath];

const child = spawn(process.execPath, [cli, ...args], {
  stdio: "inherit",
  // The CLI must see the deployment's chromium/sandbox paths (PLAYWRIGHT_*).
  env: process.env,
  // Screenshots resolve against the CLI's cwd (see above); pin it to the
  // resolved output dir when we have one, else inherit.
  ...(laneOutputDir && existsSync(laneOutputDir) ? { cwd: laneOutputDir } : {}),
});
const cleanupConfig = () => {
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
};
child.on("exit", cleanupConfig);
process.on("exit", cleanupConfig);
child.on("error", (err) => {
  console.error(`[browser-mcp] failed to start @playwright/mcp: ${err?.message || err}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[browser-mcp] @playwright/mcp exited on ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
// The MCP host closes our stdin when it goes away; stop the browser with us.
process.stdin.on("end", () => child.kill("SIGTERM"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
