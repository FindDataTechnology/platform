#!/usr/bin/env node
// ── Post-build verification: bundled resources are present ──────────────────
//
// Asserts the bundled standalone Node exists in resources/ before packing an
// installer — server.js always runs on it, so a missing one produces a broken
// app. Also warns when macOS code-signing credentials are absent.
//
// OpenConnector/LiteLLM/Postgres are no longer bundled (dsh's native plugins
// cover LLM routing and SaaS connectors), so the bundled Node is the only
// resource to check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RESOURCES_ROOT = path.join(PROJECT_ROOT, "resources");

const IS_WIN = process.platform === "win32";
const nodePath = path.join(RESOURCES_ROOT, "node", ...(IS_WIN ? ["node.exe"] : ["bin", "node"]));

console.log("🔍 Verifying bundled resources...");

let allGood = true;
if (fs.existsSync(nodePath)) {
  console.log("✅ Bundled Node: OK");
} else {
  console.error(`❌ Bundled Node missing at: ${nodePath}`);
  allGood = false;
}

// The dsh runtime binary and its nested component tree must be present in the
// dependency tree the installer will pack — a packaged install cannot fall
// back to a global `dsh` (win-install-smoke 2026-10-08: spawn dsh ENOENT on a
// clean machine, then cordis-plugin-group missing from the nested closure).
// The bundled bin.js is exactly the path dsh-bridge.js resolves at runtime.
const bundledDshBin = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const nestedRuntimeProbe = path.join(
  PROJECT_ROOT, "node_modules", "@deepseek-ai", "dsh", "node_modules",
  "@deepseek-ai", "dsh-app-boot", "package.json",
);
if (fs.existsSync(bundledDshBin)) {
  console.log("✅ Bundled dsh runtime bin: OK");
} else {
  console.error(`❌ Bundled dsh runtime missing at: ${bundledDshBin}`);
  console.error("   @deepseek-ai/dsh must be a dependency — a packaged install has no global dsh.");
  allGood = false;
}
if (fs.existsSync(nestedRuntimeProbe)) {
  console.log("✅ dsh nested runtime tree: OK");
} else {
  console.error(`❌ dsh nested runtime tree missing at: ${path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(nestedRuntimeProbe)))))}`);
  console.error("   dsh loads its components dynamically from its nested node_modules — without them the packaged agent dies on first boot.");
  allGood = false;
}

// Warn about signing if no credentials set
if (!process.env.CSC_LINK && process.platform === "darwin") {
  console.log("\n⚠️  CSC_LINK / CSC_KEY_PASSWORD not set in environment.");
  console.log("   The resulting .dmg will not pass Gatekeeper on other machines.");
  console.log("   Set these env vars before building for a signed, notarized release.\n");
}

if (!allGood) {
  console.error("\n❌ Verification failed: bundled resources are incomplete.");
  console.error("   Run `npm run predist` to build them before `npm run dist`.");
  process.exit(1);
}

console.log("\n✅ Bundled resources OK.");
process.exit(0);
