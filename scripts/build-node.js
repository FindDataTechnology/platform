#!/usr/bin/env node
// ── Build bundled standalone Node into resources/node/ (cross-platform) ───────
//
// Downloads the official Node standalone build that MATCHES process.version -
// the exact Node running this build - so the bundled Node's module ABI equals
// the ABI that `better-sqlite3` / `tree-sitter` / `fsevents` were compiled
// against at `npm ci` time. `electron-builder.yml` sets `npmRebuild: false`,
// so the prebuilt/compiled `.node` files are used as-is: the bundled Node and
// the install-time Node MUST be the same version, or the packaged app crashes
// on the first native-addon call. Reading `process.version` (instead of a
// pinned constant) makes this invariant hold automatically in every
// environment - local dev and CI - regardless of which Node is active.
//
// Override the version with PLATFORM_NODE_VERSION (rare; for pinning CI to a
// specific release). Runs during `npm run predist`. Skips if already built.
//
// mac arm64/x64 + win x64 (the electron-builder targets) + linux x64 (Docker
// image build) are built; the script exits 0 (no-op) elsewhere. Uses `curl` +
// `tar` (both shipped on Windows 10+, macOS, and Linux) so no bash.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(PROJECT_ROOT, "resources", "node");

const IS_WIN = process.platform === "win32";
// mac arm64 + mac x64 (via Rosetta on an arm64 host) + linux x64 (Docker) + win x64 are build targets.
const IS_TARGET =
  (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) ||
  (process.platform === "linux" && process.arch === "x64") ||
  (process.platform === "win32" && process.arch === "x64");
if (!IS_TARGET) {
  console.warn(`⚠️  Skipping Node build: only mac arm64/x64 / linux x64 / win x64 supported. Got ${process.platform}/${process.arch}`);
  process.exit(0);
}

// Match the Node running the build (ABI parity with the prebuilt native addons).
// process.version is like "v25.9.0". process.arch is "arm64"|"x64" -> matches
// nodejs.org asset suffixes (darwin-arm64 / darwin-x64 / win-x64).
const VERSION = (process.env.PLATFORM_NODE_VERSION || process.version).replace(/^v/, "");
const PLATFORM_TAG = IS_WIN ? "win-x64" : process.platform === "linux" ? "linux-x64" : `darwin-${process.arch}`;
const ARCHIVE_EXT = IS_WIN ? "zip" : "tar.gz";
const ARCHIVE = `node-v${VERSION}-${PLATFORM_TAG}.${ARCHIVE_EXT}`;
const URL = `https://nodejs.org/dist/v${VERSION}/${ARCHIVE}`;

// Platform binary path the supervisor expects (mirror electron/main.js):
//   mac -> resources/node/bin/node ;  win -> resources/node/node.exe
// (nodejs.org ships mac Node under bin/ and win node.exe at the archive root.)
const NODE_BIN = IS_WIN
  ? path.join(TARGET, "node.exe")
  : path.join(TARGET, "bin", "node");

// Skip if already built.
if (fs.existsSync(NODE_BIN)) {
  console.log("✅ Bundled Node already present - skipping");
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// Proxy for curl (thread explicitly - inherited env can drop it).
const PROXY = process.env.http_proxy || process.env.HTTP_PROXY || "";
const curlProxy = PROXY ? ["--proxy", PROXY] : [];

fs.mkdirSync(TARGET, { recursive: true });
console.log(`🔨 Building bundled Node v${VERSION} (${process.platform}/${process.arch})`);

// 1. Download the official standalone Node matching the running version.
const archivePath = path.join(TARGET, ARCHIVE);
console.log(`Downloading: ${URL}`);
run("curl", ["-fL", ...curlProxy, URL, "-o", archivePath]);

// 2. Verify the download is real (>5MB) before extracting (catches a 404 page).
const size = fs.statSync(archivePath).size;
if (size < 5_000_000) {
  console.error(`❌ Downloaded archive is only ${size} bytes - expected >5MB. Aborting (likely a 404 error page).`);
  console.error(fs.readFileSync(archivePath, "utf8").slice(0, 500));
  fs.rmSync(archivePath, { force: true });
  process.exit(1);
}

// 3. Extract. `tar -xf` handles both .tar.gz (mac) and .zip (win10+ bsdtar).
console.log("Extracting Node...");
run("tar", ["-xf", archivePath], { cwd: TARGET });

// 4. The archive extracts to a versioned dir node-v{VERSION}-{platform}-{arch}/.
//    Flatten it: move its contents up one level into resources/node/.
const inner = path.join(TARGET, `node-v${VERSION}-${PLATFORM_TAG}`);
if (fs.existsSync(inner)) {
  for (const entry of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, entry), path.join(TARGET, entry));
  }
  fs.rmdirSync(inner);
}
fs.rmSync(archivePath, { force: true });

// 5. Sanity-check the binary landed where the supervisor expects it.
if (!fs.existsSync(NODE_BIN)) {
  console.error(`❌ Expected Node binary not found at: ${NODE_BIN}`);
  console.error("   Check the archive layout (nodejs.org may have changed it).");
  process.exit(1);
}
// mac: ensure the binary is executable (tar preserves perms, but be safe).
if (!IS_WIN) {
  fs.chmodSync(NODE_BIN, 0o755);
}

console.log(`✅ Done: Node v${VERSION} -> ${NODE_BIN}`);
