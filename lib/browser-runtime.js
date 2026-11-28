// ── Browser runtime resolution (one source for both lane shapes) ─────────────
//
// Two processes need the exact same answers to "which @playwright/mcp CLI" and
// "which chromium binary": the per-cell stdio shim (server/browser-mcp.js, the
// pre-shared shape) and the pod-level shared service
// (server/browser-lane-service.js, slim-browser-lane-footprint). They used to
// live inside the shim; extracting them here means the shared service cannot
// drift from the lane's pinned version/flags — the 2026-10-28 image smoke found
// the lane pointing at a system Chrome that the image does not have, and a
// second copy of this resolution logic is exactly how that recurs.
//
// Everything here is pure Node + fs: no MCP SDK, no process spawning.

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// @playwright/mcp's `--browser` takes CHANNELS (chrome/firefox/webkit/msedge)
// and its default `chrome` resolves to a system Google Chrome the deployment
// does not have — the bundled chromium we bake is invisible to it. Point it at
// our binary explicitly (2026-10-28: the image smoke caught exactly this,
// "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome").
// Resolution order: BROWSER_CHROMIUM_PATH, else a scan of the browsers dir for
// the chromium build playwright installs (linux and macOS layouts, full
// chromium first, then the headless shell).
const BROWSER_BINARY_CANDIDATES = [
  [
    /(^|-)chromium-\d+$/,
    [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    ],
  ],
  [
    /^chromium_headless_shell-\d+$/,
    [
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-headless-shell-linux/chrome-headless-shell",
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-headless-shell-mac-x64/chrome-headless-shell",
    ],
  ],
];

export function resolveCli(env = process.env) {
  const configured = (env.BROWSER_MCP_CLI || "").trim();
  if (configured) return existsSync(configured) ? configured : null;
  // Fallback: a tree that declares @playwright/mcp (the packaged app tree can,
  // once a deployment chooses to bake it there).
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@playwright/mcp/cli.js");
  } catch {
    return null;
  }
}

export function resolveChromium(env = process.env) {
  const explicit = (env.BROWSER_CHROMIUM_PATH || "").trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const root = (env.PLAYWRIGHT_BROWSERS_PATH || "/opt/browser-mcp/ms-playwright").trim();
  if (!root || !existsSync(root)) return null;
  let entries = [];
  try {
    entries = readdirSync(root).sort().reverse(); // newest build first
  } catch {
    return null;
  }
  for (const [pattern, suffixes] of BROWSER_BINARY_CANDIDATES) {
    for (const dir of entries.filter((e) => pattern.test(e))) {
      for (const suffix of suffixes) {
        const candidate = join(root, dir, suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

// Launch configuration goes through the CLI's --config file, not flags: the
// chromium ARGS we need (see the sandbox note) have no CLI passthrough, and
// browser.launchOptions is the supported surface (config.d.ts).
//
// Container reality: the runtime image runs as the non-root `node` user and
// Chromium's sandbox needs root or a configured user-namespace profile — the
// headless launch died with "Chromium sandboxing failed!" (2026-10-28 image
// smoke). Default to the standard containerized-headless posture (--no-sandbox
// + --disable-dev-shm-usage, the latter for the small /dev/shm containers
// normally have); BROWSER_SANDBOX=1 keeps the sandbox on for deployments that
// configure userns/seccomp and a sized /dev/shm. The browser browses untrusted
// pages, so this is a real trade-off — taken deliberately and visible here
// rather than buried in a run script.
//
// Returns { config, error }: `error` is the operator-facing reason the lane
// cannot launch (no CLI, no chromium), already phrased for stderr/log.
export function resolveBrowserLaunchConfig({ env = process.env, outputDir = "" } = {}) {
  const cli = resolveCli(env);
  if (!cli) {
    return {
      cli: null,
      config: null,
      error:
        "@playwright/mcp is not installed in this deployment " +
        "(set BROWSER_MCP_CLI, or BROWSER_LANE=off to omit the lane deliberately)",
    };
  }
  const endpoint = (env.BROWSER_CDP_ENDPOINT || "").trim();
  const headless = env.BROWSER_HEADLESS !== "0";
  const browserConfig = { browser: {} };
  if (endpoint) {
    // Attach mode: an existing browser at the endpoint; no local binary needed.
    browserConfig.browser.cdpEndpoint = endpoint;
  } else {
    const chromium = resolveChromium(env);
    if (!chromium) {
      return {
        cli,
        config: null,
        error:
          "no chromium found for the browser lane " +
          "(set BROWSER_CHROMIUM_PATH, or PLAYWRIGHT_BROWSERS_PATH to the browsers dir; " +
          "the image bakes both at /opt/browser-mcp)",
      };
    }
    browserConfig.browser.launchOptions = {
      executablePath: chromium,
      headless,
      ...(env.BROWSER_SANDBOX === "1"
        ? {}
        : { args: ["--no-sandbox", "--disable-dev-shm-usage"] }),
    };
  }
  const resolvedOutputDir = (outputDir || "").trim();
  if (resolvedOutputDir) browserConfig.outputDir = resolvedOutputDir;
  return { cli, config: browserConfig, error: null };
}
