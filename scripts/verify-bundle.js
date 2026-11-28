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

// The dsh runtime must be present in the tree the installer packs — a packaged
// install cannot fall back to a global `dsh` (win-install-smoke 2026-10-08:
// spawn dsh ENOENT on a clean machine). The bundled bin.js is exactly the path
// dsh-bridge.js resolves at runtime.
//
// Single-source assertion (single-source-desktop-runtime D2/D5): the runtime
// closure is installed from dsh-matrix by scripts/install-dsh-matrix.mjs, so
// the packed dsh version MUST equal the matrix's intent row. A drift here
// means the desktop and the server image are on different runtimes — exactly
// the class of split this change removed.
const bundledDshBin = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const bundledDshPkg = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", "dsh", "package.json");
const matrixManifestPath = path.join(PROJECT_ROOT, "dsh-matrix", "package.json");
if (fs.existsSync(bundledDshBin) && fs.existsSync(bundledDshPkg)) {
  console.log("✅ Bundled dsh runtime bin: OK");
  try {
    const installed = JSON.parse(fs.readFileSync(bundledDshPkg, "utf8")).version;
    const intent = JSON.parse(fs.readFileSync(matrixManifestPath, "utf8")).dependencies?.["@deepseek-ai/dsh"];
    if (intent && installed !== intent) {
      console.error(`❌ Bundled dsh version drift: app tree has ${installed}, dsh-matrix intends ${intent}.`);
      console.error("   Run `node scripts/install-dsh-matrix.mjs` (or the full predist) to re-sync from the matrix.");
      allGood = false;
    } else {
      console.log(`✅ Bundled dsh version matches the matrix intent: ${installed}`);
    }
  } catch (err) {
    console.error(`❌ dsh version assertion could not run: ${err?.message || err}`);
    allGood = false;
  }
} else {
  console.error(`❌ Bundled dsh runtime missing at: ${bundledDshBin}`);
  console.error("   Run predist (scripts/install-dsh-matrix.mjs installs it from dsh-matrix).");
  allGood = false;
}

// The profile bridge plugins import these by bare specifier, and the dsh
// loader resolves them ONLY up the profile dir's own node_modules (dsh-profile
// links them from here on packaged installs). npm auto-installed them as
// peers in dev trees, but legacy-peer-deps installs prune them — a missing
// one resurfaces as a packaged-only bridge boot failure (v1.3.5 round).
const bridgePackages = ["schemastery", "dsh-session", "dsh-tools", "dsh-sdk-jsonrpc-server", "dsh-llm-deepseek"];
for (const pkg of bridgePackages) {
  const pkgDir = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", pkg);
  if (fs.existsSync(path.join(pkgDir, "package.json"))) {
    console.log(`✅ Bridge dependency @deepseek-ai/${pkg}: OK`);
  } else {
    console.error(`❌ Bridge dependency @deepseek-ai/${pkg} missing from node_modules — pin it in package.json dependencies.`);
    allGood = false;
  }
}

// Warn about signing if no credentials set
if (!process.env.CSC_LINK && process.platform === "darwin") {
  console.log("\n⚠️  CSC_LINK / CSC_KEY_PASSWORD not set in environment.");
  console.log("   The resulting .dmg will not pass Gatekeeper on other machines.");
  console.log("   Set these env vars before building for a signed, notarized release.\n");
}

// Collector-coverage gate (single-source-desktop-runtime, v1.3.9 lesson):
// electron-builder's node_modules collector walks dependencies+optionalDeps
// but NEVER peerDependencies — runtime packages only peer-reachable (the
// 0.2.0 dsh graph reaches ~64 foundation/plugin packages that way, plus
// their unscoped deps) get silently dropped (v1.3.9 exe: "Cannot find
// package '@deepseek-ai/dsh-sdk-protocol'" — the backend crash-looped on
// clean machines while the build tree looked healthy). electron-builder.js's
// afterPack syncs the runtime tree verbatim using the shared classifier in
// scripts/lib/packaged-tree.mjs (fixpoint: ships = @deepseek-ai scope ∪
// dependencies closure ∪ everything they require, peers included). This gate
// re-runs the classifier and proves the two properties that make the
// verbatim copy safe: (1) every @deepseek-ai package the pruned tree holds
// ships, and (2) nothing the runtime could resolve into is left in devOnly.
{
  const { computePackagedTree } = await import("./lib/packaged-tree.mjs");
  const root = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const { ships, devOnly, top } = computePackagedTree({ nmDir: path.join(PROJECT_ROOT, "node_modules"), rootPkg: root });

  const scopeMissing = [];
  for (const name of top) {
    if (name.startsWith("@deepseek-ai/") && !ships.has(name)) scopeMissing.push(name);
  }
  // The packages afterPack skips (devOnly ∪ pruned). Pruned ones are
  // intentional; devOnly ones must not be @deepseek-ai (the runtime family).
  const prunePatterns = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "dsh-matrix", "prune.json"), "utf8"))
        .prune.flatMap((e) => e.match);
    } catch {
      return [];
    }
  })();
  const isPruned = (name) => prunePatterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
  const badSkips = devOnly.filter((n) => n.startsWith("@deepseek-ai/") && !isPruned(n));

  if (scopeMissing.length || badSkips.length) {
    console.error("❌ Collector coverage: the afterPack dev-only exclusion would drop runtime packages:");
    for (const n of scopeMissing) console.error(`     ${n} (in tree, not classified shipping)`);
    for (const n of badSkips) console.error(`     ${n} (@deepseek-ai package classified dev-only, not pruned)`);
    allGood = false;
  } else {
    console.log(
      `✅ Collector coverage: ${ships.size} packages ship verbatim via afterPack; ${devOnly.length} dev-only skipped; no runtime package dropped`,
    );
  }
}

// Runtime-directory coverage gate (desktop-catch-up-release): the positive
// files-list entries for runtime directories are GENERATED from RUNTIME_DIRS
// (electron-builder.js), and this gate proves the descriptor spawn graph is
// covered by that same list — every project-relative path supervisor
// descriptors spawn (and every RUNTIME_DIRS entry itself) must exist in the
// build tree. Third shipped instance of the class: v1.3.13 packed the fleet
// descriptor's agent-runner spawn without packing agent-runner/.
{
  const { RUNTIME_DIRS, runtimeDirCoverageProblems } = await import("./lib/runtime-dirs.mjs");
  const descriptorPath = path.join(PROJECT_ROOT, "supervisor", "descriptors.js");
  const descriptorSource = fs.readFileSync(descriptorPath, "utf8");
  const problems = runtimeDirCoverageProblems({ root: PROJECT_ROOT, descriptorSource });
  if (problems.length) {
    for (const p of problems) console.error(`❌ Runtime-dir coverage: ${p}`);
    allGood = false;
  } else {
    console.log(`✅ Runtime-dir coverage: ${RUNTIME_DIRS.length} dirs packed; supervisor descriptor spawns all covered`);
  }
}

if (!allGood) {
  console.error("\n❌ Verification failed: bundled resources are incomplete.");
  console.error("   Run `npm run predist` to build them before `npm run dist`.");
  process.exit(1);
}

console.log("\n✅ Bundled resources OK.");
process.exit(0);
