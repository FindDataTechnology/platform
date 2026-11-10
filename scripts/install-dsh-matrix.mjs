#!/usr/bin/env node
// ── Install the dsh runtime into the app tree from the matrix manifest ──────
//
// single-source-desktop-runtime D2: the desktop's dsh runtime has ONE source —
// dsh-matrix/ (manifest + frozen lock + prune list) — the same source the
// server image's /opt/dsh installs from. Before this step existed the desktop
// closure came from 41 runtime rows in the root package.json (a per-package
// hand-maintained list that had to be bumped in lockstep with the matrix) plus
// a nested-tree hoist that 0.2.0's flat hard-dependency layout made meaningless.
//
// The step, isomorphic to the Dockerfile's install:
//   1. `npm ci` in a build-local staging dir (source: dsh-matrix manifest+lock+.npmrc)
//   2. prune per dsh-matrix/prune.json (the shared list — never a copy)
//   3. merge the staged tree into the app's node_modules, top level only,
//      NEVER overwriting a package npm already resolved (same discipline the
//      old nested hoist used; npm's resolution already validated those).
//   4. prune the APP tree with the same list. Step 3's never-overwrite rule
//      means the app's own copies survive the merge — and they include the
//      prunable payload (measured 2026-10-14: @deepseek-ai/dsh-sdk-client
//      hard-depends on @deepseek-ai/dsh, so the root closure transitively
//      carries the whole family: libreoffice-kit-darwin-arm64 148MB +
//      dsh-client-ui-*/dsh-web-* ~38MB on a desktop tree). Without this step
//      the desktop ships what the image's /opt/dsh prunes away.
//
// Idempotent. Runs inside `predist`, replacing the old hoist step.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_DIR = path.join(PROJECT_ROOT, "dsh-matrix");
const STAGING = path.join(PROJECT_ROOT, "node_modules", ".dsh-matrix-staging");
const TOP = path.join(PROJECT_ROOT, "node_modules");

if (!existsSync(path.join(MATRIX_DIR, "package.json")) || !existsSync(path.join(MATRIX_DIR, "package-lock.json"))) {
  console.error(`❌ dsh-matrix manifest/lock missing under ${MATRIX_DIR}`);
  process.exit(1);
}

// The matrix's intent rows — the version every @deepseek-ai/dsh* in the app
// tree must end up at (verify-bundle re-asserts this after the merge).
const matrixManifest = JSON.parse(readFileSync(path.join(MATRIX_DIR, "package.json"), "utf8"));
const dshIntentVersion = matrixManifest.dependencies?.["@deepseek-ai/dsh"];

console.log(`📦 Installing the dsh matrix runtime into the app tree (intent dsh@${dshIntentVersion})…`);

// ── 1. staging install ───────────────────────────────────────────────────────
// Clean every run: `npm ci` itself requires an empty/absent node_modules and
// refuses a tree whose lock does not match, which is exactly the guarantee we
// want from a frozen lock.
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
for (const f of ["package.json", "package-lock.json", ".npmrc"]) {
  const src = path.join(MATRIX_DIR, f);
  if (existsSync(src)) cpSync(src, path.join(STAGING, f));
}
// file: dependency sources (the plugin-supply sample bundle's whitelist row)
// resolve relative to the staging manifest exactly as they do inside
// dsh-matrix/ — the lock records them as links, so npm ci reads the real
// directory from here (add-dsh-plugin-supply).
const samplesSrc = path.join(MATRIX_DIR, "samples");
if (existsSync(samplesSrc)) cpSync(samplesSrc, path.join(STAGING, "samples"), { recursive: true });
try {
  // shell:true so Windows resolves `npm` → npm.cmd (a .cmd batch file that
  // execFileSync cannot exec without a shell; same trap postinstall-web.js
  // documents — release run 38539016384: `staging npm ci failed: spawnSync
  // npm ENOENT` on windows-latest).
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--omit=optional"], {
    cwd: STAGING,
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
} catch (err) {
  console.error(`❌ staging npm ci failed: ${err?.message || err}`);
  process.exit(1);
}

// ── 2. prune (shared list; the same script the image runs) ───────────────────
try {
  execFileSync(process.execPath, [path.join(MATRIX_DIR, "prune.mjs"), "--tree", STAGING], {
    stdio: ["ignore", "inherit", "inherit"],
  });
} catch (err) {
  console.error(`❌ prune failed: ${err?.message || err}`);
  process.exit(1);
}

// ── 3. merge into the app tree ───────────────────────────────────────────────
// Top-level packages only. Nested node_modules inside a package are its own
// dependency copies and travel with it (cpSync recursive) — flattening them
// would break the exact-pinned layout the lock describes.
let copied = 0;
let skipped = 0;

const stagedTop = path.join(STAGING, "node_modules");
for (const entry of readdirSync(stagedTop, { withFileTypes: true })) {
  if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
  if (entry.name.startsWith("@")) {
    const scopeSrc = path.join(stagedTop, entry.name);
    const scopeDest = path.join(TOP, entry.name);
    mkdirSync(scopeDest, { recursive: true });
    for (const pkg of readdirSync(scopeSrc, { withFileTypes: true })) {
      if (!pkg.isDirectory() && !pkg.isSymbolicLink()) continue;
      merge(path.join(scopeSrc, pkg.name), path.join(scopeDest, pkg.name));
    }
  } else {
    merge(path.join(stagedTop, entry.name), path.join(TOP, entry.name));
  }
}

function merge(src, dest) {
  // Never overwrite: the root tree's own resolution (the platform's 9 direct
  // import rows + their closure) wins; the matrix fills everything else.
  if (existsSync(dest)) {
    skipped++;
    return;
  }
  // dereference: file: dependencies arrive as links into the staging dir;
  // the packaged app must carry real files (the staging dir is deleted at the
  // end of this script and never ships) — add-dsh-plugin-supply.
  cpSync(src, dest, { recursive: true, dereference: true });
  copied++;
}

// The matrix bin shim (node_modules/.bin/dsh) — the old nested install exposed
// one implicitly; make it explicit so a dev tree and a packaged tree resolve
// the CLI identically.
const stagedBin = path.join(STAGING, "node_modules", ".bin", "dsh");
const topBin = path.join(TOP, ".bin", "dsh");
if (existsSync(stagedBin) && !existsSync(topBin)) {
  mkdirSync(path.dirname(topBin), { recursive: true });
  try {
    const target = readFileSync(stagedBin, "utf8").match(/"\$basedir\/([^"]+)"/)?.[1];
    if (target) symlinkSync(path.join("..", "@deepseek-ai", "dsh", target), topBin);
  } catch { /* the shim is a convenience — verify-bundle asserts the real entry */ }
}

rmSync(STAGING, { recursive: true, force: true });

// ── 4. prune the APP tree (same shared list) ─────────────────────────────────
// The app tree's own lock (package-lock.json) enumerates what root npm ci
// installed; prune.mjs reads that lock from the tree root. Re-runnable: a
// later `npm ci` restores the packages, and the next predist prunes again.
try {
  execFileSync(process.execPath, [path.join(MATRIX_DIR, "prune.mjs"), "--tree", PROJECT_ROOT], {
    stdio: ["ignore", "inherit", "inherit"],
  });
} catch (err) {
  console.error(`❌ app-tree prune failed: ${err?.message || err}`);
  process.exit(1);
}

console.log(`✅ dsh matrix merged into app tree: ${copied} package(s) copied, ${skipped} already present (kept).`);
