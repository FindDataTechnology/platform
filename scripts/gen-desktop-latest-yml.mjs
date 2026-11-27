#!/usr/bin/env node
// ── Desktop release lane metadata generator (add-desktop-in-app-update) ─────
//
// CI (release.yml) runs this after electron-builder to produce the lane
// metadata electron-updater reads: latest.yml (Windows NSIS) and
// latest-mac.yml (dmg) — version + per-file sha512/size, the exact shape
// electron-builder itself emits. Write-then-rename per file, so a half-written
// yml can never land on the lane (the client's spec: 哈希不匹配拒装).
//
// Usage: node scripts/gen-desktop-latest-yml.mjs <distDir> <version>
// Writes: <distDir>/latest.yml and/or <distDir>/latest-mac.yml (whichever
// artifacts exist).

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

const collect = (suffix) =>
  readdirSync(distDir)
    .filter((f) => f.endsWith(suffix) && !f.endsWith(".blockmap"))
    .sort()
    .map((f) => {
      const full = join(distDir, f);
      return { file: f, sha512: sha512Of(full), size: statSync(full).size };
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
if (win.length) writeLane("latest.yml", win);
if (mac.length) writeLane("latest-mac.yml", mac);
if (!win.length && !mac.length) {
  console.error("gen-desktop-latest-yml: no .exe/.dmg artifacts in dist — nothing written");
  process.exit(1);
}
