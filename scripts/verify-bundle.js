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
