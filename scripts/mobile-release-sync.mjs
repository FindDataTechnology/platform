#!/usr/bin/env node
// ── Mobile release sync (add-mobile-distribution D2) ────────────────────────
//
// Publishes an Android APK to the same public download host the desktop uses,
// and maintains the manifest the app's in-app update check reads:
//
//   /dl/app/<version>/<file>.apk
//   /dl/app/app-releases.json   { schema, releases:[…] }   newest-first
//
// The manifest is the ONLY thing the client reads (no app store, no account),
// so it must list formal releases only, and every url in it must actually
// answer. Both are asserted below before the manifest is written.
//
//   node scripts/mobile-release-sync.mjs v0.1.0 [--beta] [--dry-run] [--skip-rsync]
//
// Env: DL_HOST (ssh host), DL_ROOT (/srv/dl), DL_BASE (public https base),
//      GH_REPO (default FindDataTechnology/platform).
// Run from an operator machine holding gh + ssh — never CI.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

export const APP_DIR_NAME = "app";
export const MANIFEST_NAME = "app-releases.json";
const SEMVER = /^\d+\.\d+\.\d+$/;

export function assertFormalVersion(version) {
  if (!SEMVER.test(String(version))) {
    throw new Error(`"${version}" is not a formal MAJOR.MINOR.PATCH version — pre-releases must not reach the public manifest`);
  }
}

export function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// The APK a release carries. Named by our convention (yizuo-<version>.apk), but
// any single .apk asset is accepted — the file name is recorded as-is.
export function pickApkAsset(assets, version) {
  const apks = assets.filter((a) => /\.apk$/i.test(a.name));
  if (!apks.length) throw new Error(`release v${version} carries no .apk asset`);
  const preferred = apks.find((a) => a.name === `yizuo-${version}.apk`);
  return preferred ?? apks[0];
}

export function buildReleaseEntry({ version, releasedAt, asset, sha256, size, dlBase, beta = false }) {
  return {
    version,
    released_at: releasedAt,
    prerelease: beta,
    filename: asset.name,
    size,
    sha256,
    url: `${dlBase}/app/${version}/${encodeURIComponent(asset.name)}`,
  };
}

// Merge rule: newest-first, same version replaces (re-runs converge), and the
// manifest never carries a pre-release entry.
export function mergeManifest(existing, entry) {
  const releases = (existing?.releases ?? []).filter((r) => r.version !== entry.version && r.prerelease !== true);
  if (entry.prerelease !== true) releases.push(entry);
  releases.sort((a, b) => compareSemver(b.version, a.version));
  return { schema: 1, releases };
}

export function compareSemver(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// Every url in the manifest must answer 200 — a manifest is a promise the app
// acts on, and a dead link there is indistinguishable from "no update".
export function deadLinks(manifest, check) {
  const dead = [];
  for (const r of manifest.releases) if (!check(r.url)) dead.push(r.url);
  return dead;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

async function main() {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error("usage: mobile-release-sync.mjs v<semver> [--beta] [--dry-run] [--skip-rsync]");
    process.exit(2);
  }
  const flags = new Set(process.argv.slice(3).filter((a) => a.startsWith("--")));
  const version = tag.replace(/^v/, "");
  assertFormalVersion(version);

  const repo = process.env.GH_REPO || "FindDataTechnology/platform";
  const dlHost = process.env.DL_HOST;
  const dlRoot = process.env.DL_ROOT || "/srv/dl";
  const dlBase = process.env.DL_BASE || "https://platform.finddatatech.cloud/dl";

  const release = JSON.parse(run("gh", ["api", `repos/${repo}/releases/tags/${tag}`]));
  const asset = pickApkAsset(release.assets, version);
  console.log(`[1/3] ${tag}: APK asset ${asset.name} (${asset.size} bytes)`);

  const cacheDir = path.join(homedir(), ".cache", "fd-mobile-release", version);
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, asset.name);
  if (existsSync(file) && statSync(file).size !== asset.size) rmSync(file, { force: true });
  if (!existsSync(file)) {
    console.log(`      downloading ${asset.name} …`);
    execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", asset.name, "--dir", cacheDir], { stdio: "inherit" });
  }
  const size = statSync(file).size;
  if (size !== asset.size) throw new Error(`${asset.name} is ${size} bytes, release says ${asset.size} — refusing to publish a truncated APK`);
  const sha256 = sha256Of(file);

  const entry = buildReleaseEntry({
    version,
    releasedAt: (release.published_at || "").slice(0, 10),
    asset,
    sha256,
    size,
    dlBase,
    beta: flags.has("--beta"),
  });
  console.log(`[2/3] sha256 ${sha256.slice(0, 16)}… ; url ${entry.url}`);

  if (flags.has("--dry-run")) {
    console.log(JSON.stringify(mergeManifest(null, entry), null, 2));
    console.log("[dry-run] stopping before upload/manifest write");
    return;
  }
  if (flags.has("--skip-rsync")) {
    console.log("[3/3] skipped (--skip-rsync)");
    return;
  }
  if (!dlHost) throw new Error("DL_HOST is not set — set it or pass --skip-rsync");

  const dest = `${dlHost}:${dlRoot}/${APP_DIR_NAME}/${version}/`;
  run("rsync", ["-c", "--progress", file, dest]);
  console.log(`[3/3] rsynced ${asset.name} → ${dest}`);

  // Read the live manifest back so a re-run merges instead of overwriting.
  let existing = { schema: 1, releases: [] };
  try {
    existing = JSON.parse(run("ssh", [dlHost, `cat ${dlRoot}/${APP_DIR_NAME}/${MANIFEST_NAME} 2>/dev/null || echo '{"schema":1,"releases":[]}'`]));
  } catch { /* first publish */ }
  const next = mergeManifest(existing, entry);

  const manifestFile = path.join(cacheDir, MANIFEST_NAME);
  writeFileSync(manifestFile, `${JSON.stringify(next, null, 2)}\n`);
  run("rsync", ["-c", manifestFile, `${dlHost}:${dlRoot}/${APP_DIR_NAME}/`]);
  console.log(`      manifest now lists ${next.releases.map((r) => r.version).join(", ")}`);

  const dead = deadLinks(next, (url) => run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", url]).trim() === "200");
  if (dead.length) throw new Error(`manifest lists unreachable artifact(s): ${dead.join(", ")} — the manifest was written; fix the files or re-run`);
  console.log(`      all ${next.releases.length} manifest url(s) answer 200`);
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`mobile-release-sync failed: ${err.message}`);
    process.exit(1);
  });
}
