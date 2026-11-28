#!/usr/bin/env node
// ── Desktop release lane metadata generator (add-desktop-in-app-update) ─────
//
// CI (release.yml) runs this after electron-builder to produce the lane
// metadata electron-updater reads: latest.yml (Windows NSIS), latest-mac.yml
// (dmg) and latest-linux.yml (AppImage) — version + per-file sha512/size, the
// exact shape electron-builder itself emits. Write-then-rename per file, so a half-written
// yml can never land on the lane (the client's spec: 哈希不匹配拒装).
//
// Usage: node scripts/gen-desktop-latest-yml.mjs <distDir> <version>
// Writes: <distDir>/latest.yml, latest-mac.yml and/or latest-linux.yml
// (whichever artifacts exist).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateLatestYml } from "../electron/updater-core.js";

const distDir = process.argv[2];
const version = process.argv[3];
if (!distDir || !version) {
  console.error("usage: gen-desktop-latest-yml.mjs <distDir> <version>");
  process.exit(1);
}

const sha512Of = (file) => createHash("sha512").update(readFileSync(file)).digest("base64");

const all = readdirSync(distDir);
// Blockmaps stay LANE CONTENT (differential updates) but never become file
// entries themselves; their size rides on the artifact they describe.
const blockMapFor = (file) => {
  const candidate = `${file}.blockmap`;
  return all.includes(candidate) ? statSync(join(distDir, candidate)).size : null;
};

const collect = (suffix) =>
  all
    .filter((f) => f.endsWith(suffix) && !f.endsWith(".blockmap"))
    .sort()
    .map((f) => {
      const full = join(distDir, f);
      const blockMapSize = blockMapFor(f);
      return { file: f, sha512: sha512Of(full), size: statSync(full).size, ...(blockMapSize ? { blockMapSize } : {}) };
    });

const writeLane = (name, files) => {
  const yml = generateLatestYml({ version, files });
  const tmp = join(distDir, `.${name}.tmp`);
  writeFileSync(tmp, yml);
  renameSync(tmp, join(distDir, name));
  console.log(`gen-desktop-latest-yml: ${name} (${files.length} file(s), v${version})`);
};

const win = collect(".exe");
const mac = collect(".dmg");
const linux = collect(".AppImage");
if (win.length) writeLane("latest.yml", win);
if (mac.length) writeLane("latest-mac.yml", mac);
if (linux.length) writeLane("latest-linux.yml", linux);
if (!win.length && !mac.length && !linux.length) {
  console.error("gen-desktop-latest-yml: no .exe/.dmg/.AppImage artifacts in dist — nothing written");
  process.exit(1);
}
