#!/usr/bin/env node
// release-sync — the add-desktop-release one-shot publish chain (design D2).
//
//   node scripts/release-sync.mjs v1.3.0 [--beta=windows] [--dl-live] [--dry-run] [--prune] [--skip-rsync]
//
// Steps (each fails loudly at the offending step; nothing is committed before
// the snapshot passes the site's own validation rules):
//   1. gh api  → the GitHub Release + its assets for <tag>
//   2. map     → download-center snapshot entry (asset-name mapping, design D3:
//                macos links the arm64 dmg + the Release page; windows links
//                the exe directly; x64 dmg is synced to dl but not linked)
//   3. write   → merge into fd-official-web src/data/desktop-releases.json
//                (newest-first, same-version replace = re-runnable), commit,
//                push both remotes (the site rolls on the image line)
//   4. rsync   → download assets to a local cache, rsync to the dl host under
//                /platform/<version>/; --prune keeps the newest 2 version dirs
//
// Env: FD_WEB_DIR (default ~/finddata/fd-official-web), DL_HOST, DL_ROOT
// (default /srv/dl), GH_REPO (default FindDataTechnology/platform).
// Run from a dev machine holding gh + gitee + ssh credentials — never CI.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

// ── Snapshot rules (mirror of fd-official-web src/lib/desktop-releases.ts ──
// the cross-repo contract; both sides change together, see
// openspec/changes/add-desktop-release/notes/desktop-releases-snapshot-contract.md)

const DESKTOP_PLATFORMS = ["macos", "windows"];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS = /^https:\/\//;

export function validateSnapshot(snap) {
  if (!snap || typeof snap !== "object") throw new Error("snapshot must be an object");
  if (typeof snap.schema !== "number") throw new Error('missing numeric "schema" field');
  if (!Array.isArray(snap.releases)) throw new Error('"releases" must be an array');
  snap.releases.forEach((release, i) => {
    const at = `releases[${i}]`;
    if (typeof release.version !== "string" || !release.version) {
      throw new Error(`${at} is missing required field "version"`);
    }
    if (!SEMVER.test(release.version)) {
      throw new Error(`${at} has a non-semantic "version" "${release.version}" — use MAJOR.MINOR.PATCH`);
    }
    if (typeof release.released_at !== "string" || !DATE.test(release.released_at)) {
      throw new Error(`release "${release.version}" has an invalid "released_at" — use YYYY-MM-DD`);
    }
    if (!release.platforms || typeof release.platforms !== "object") {
      throw new Error(`release "${release.version}" is missing required field "platforms"`);
    }
    for (const [key, p] of Object.entries(release.platforms)) {
      if (!DESKTOP_PLATFORMS.includes(key)) {
        throw new Error(`release "${release.version}" holds unknown platform key "${key}"`);
      }
      if (typeof p.beta !== "boolean") {
        throw new Error(`release "${release.version}" platform "${key}" has an invalid "beta"`);
      }
      for (const field of ["official_url", "github_url"]) {
        if (p[field] != null && !HTTPS.test(p[field] ?? "")) {
          throw new Error(`release "${release.version}" platform "${key}" has a malformed "${field}"`);
        }
      }
      if (!HTTPS.test(p.official_url ?? "") && !HTTPS.test(p.github_url ?? "")) {
        throw new Error(`release "${release.version}" platform "${key}" carries neither an official_url nor a github_url`);
      }
    }
  });
  return snap;
}

// ── Asset mapping (design D3) ────────────────────────────────────────────────

// release: the gh api release object (tag_name, html_url, published_at, assets[]).
// opts.beta: Set of platform keys flagged beta; opts.dlLive: fill official_url;
// opts.dlBase: e.g. https://dl.finddatatech.cloud.
export function mapAssetsToEntry(release, opts = {}) {
  const beta = opts.beta ?? new Set();
  const version = release.tag_name.replace(/^v/, "");
  if (!SEMVER.test(version)) throw new Error(`tag "${release.tag_name}" is not a v<semver> tag`);
  const asset = (name) => release.assets.find((a) => a.name === name);
  // NSIS names the exe with dots on this electron-builder version
  // (Platform.Setup.1.3.0.exe); older docs say spaces. Accept both.
  const exeAsset = asset(`Platform Setup ${version}.exe`) ?? asset(`Platform.Setup.${version}.exe`);
  const arm64 = asset(`Platform-${version}-arm64.dmg`);
  const missing = [
    [!arm64, `Platform-${version}-arm64.dmg`],
    [!exeAsset, `Platform Setup ${version}.exe (or Platform.Setup.${version}.exe)`],
  ]
    .filter(([m]) => m)
    .map(([, n]) => n);
  if (missing.length) throw new Error(`release ${release.tag_name} is missing assets: ${missing.join(", ")}`);
  const dl = (name) => (opts.dlLive ? `${opts.dlBase}/platform/${version}/${encodeURIComponent(name)}` : null);
  return {
    version,
    released_at: (release.published_at || "").slice(0, 10),
    platforms: {
      // macos: the arm64 dmg is the direct artifact; the Release page is the
      // GitHub source (x64 users pick -x64.dmg there).
      macos: { beta: beta.has("macos"), filename: arm64.name, official_url: dl(arm64.name), github_url: release.html_url },
      windows: { beta: beta.has("windows"), filename: exeAsset.name, official_url: dl(exeAsset.name), github_url: exeAsset.browser_download_url },
    },
    // x64 dmg rides along to the dl host (not linked — page visitors get it
    // from the Release page), so official_url stays constructible later.
    _syncOnlyAssets: release.assets.filter((a) => a.name === `Platform-${version}-x64.dmg`).map((a) => a.name),
  };
}

// ── Merge (idempotent: same version replaces; array stays newest-first) ─────

export function mergeSnapshot(existing, entry) {
  const { _syncOnlyAssets, ...clean } = entry;
  const releases = (existing?.releases ?? []).filter((r) => r.version !== clean.version);
  releases.push(clean);
  releases.sort((a, b) => compareSemver(b.version, a.version));
  return { schema: 1, releases };
}

export function compareSemver(a, b) {
  const pa = String(a).split(/[-+]/)[0].split(".").map(Number);
  const pb = String(b).split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// ── Runner ──────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

async function main() {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error("usage: release-sync.mjs v<semver> [--beta=windows[,macos]] [--dl-live] [--dry-run] [--prune] [--skip-rsync]");
    process.exit(2);
  }
  const flags = new Set(process.argv.slice(3).filter((a) => a.startsWith("--")).map((a) => a.replace(/=.*/, "")));
  const betaFlag = process.argv.find((a) => a.startsWith("--beta="));
  const beta = new Set(betaFlag ? betaFlag.slice(7).split(",").filter(Boolean) : []);
  const repo = process.env.GH_REPO || "FindDataTechnology/platform";
  const webDir = process.env.FD_WEB_DIR || path.join(homedir(), "finddata", "fd-official-web");
  const dlHost = process.env.DL_HOST;
  const dlRoot = process.env.DL_ROOT || "/srv/dl";
  const dlBase = process.env.DL_BASE || "https://dl.finddatatech.cloud";

  // 1. Release + assets via gh api (assets ride on the release object).
  const release = JSON.parse(run("gh", ["api", `repos/${repo}/releases/tags/${tag}`]));
  console.log(`[1/4] ${tag}: ${release.assets.length} assets, published ${release.published_at}`);

  // 2. Map + validate BEFORE any write (a snapshot that would fail the site's
  // build validation never reaches the repo).
  const entry = mapAssetsToEntry(release, { beta, dlLive: flags.has("--dl-live"), dlBase });
  const snapshotPath = path.join(webDir, "src", "data", "desktop-releases.json");
  const existing = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const next = validateSnapshot(mergeSnapshot(existing, entry));
  console.log(`[2/4] snapshot entry v${entry.version} valid (beta: ${[...beta].join(",") || "none"}; official links: ${flags.has("--dl-live") ? "dl" : "github-only transition"})`);
  if (flags.has("--dry-run")) {
    console.log(JSON.stringify(next, null, 2));
    console.log("[dry-run] stopping before write/push/rsync");
    return;
  }

  // 3. Write + commit + push both remotes (the site rolls on the image line).
  writeFileSync(snapshotPath, JSON.stringify(next, null, 2) + "\n");
  const msg = `chore(data): desktop-releases v${entry.version} (release-sync)`;
  run("git", ["-C", webDir, "add", "src/data/desktop-releases.json"]);
  run("git", ["-C", webDir, "commit", "-m", msg]);
  run("git", ["-C", webDir, "push", "github", "HEAD:main"]);
  run("git", ["-C", webDir, "push", "gitee", "HEAD:main"]);
  console.log(`[3/4] ${msg} pushed (github + gitee) — site roll triggered`);

  // 4. Cache assets locally, rsync to the dl host.
  if (flags.has("--skip-rsync")) {
    console.log("[4/4] skipped (--skip-rsync)");
    return;
  }
  if (!dlHost) throw new Error("DL_HOST is not set — set it or pass --skip-rsync");
  const cacheDir = path.join(homedir(), ".cache", "fd-release-sync", entry.version);
  mkdirSync(cacheDir, { recursive: true });
  const wanted = [entry.platforms.macos.filename, entry.platforms.windows.filename, ...entry._syncOnlyAssets];
  for (const name of wanted) {
    const file = path.join(cacheDir, name);
    const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
    if (!existsSync(file)) {
      console.log(`      downloading ${name} …`);
      execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", name, "--dir", cacheDir], { stdio: "inherit" });
    } else {
      console.log(`      cached ${name}`);
    }
    void url;
  }
  const dest = `${dlHost}:${dlRoot}/platform/${entry.version}/`;
  run("rsync", ["-c", "--progress", ...wanted.map((n) => path.join(cacheDir, n)), dest]);
  console.log(`[4/4] rsynced ${wanted.length} artifacts → ${dest}`);

  if (flags.has("--prune")) {
    const dirs = run("ssh", [dlHost, `ls -1 ${dlRoot}/platform/`]).trim().split("\n").filter(Boolean);
    const victims = dirs
      .map((d) => d.replace(/^v/, ""))
      .sort((a, b) => compareSemver(b, a))
      .slice(2); // keep the newest 2 versions (spec: retention floor)
    if (victims.length) {
      run("ssh", [dlHost, `rm -rf ${victims.map((v) => `${dlRoot}/platform/${v}`).join(" ")}`]);
      console.log(`      pruned old versions: ${victims.join(", ")}`);
    }
  }
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`release-sync failed: ${err.message}`);
    process.exit(1);
  });
}
