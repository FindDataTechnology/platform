#!/usr/bin/env node
// check-voice-catalog-mount: the "change a voice without shipping an image"
// promise must not be a lie (openspec: add-room-voice-and-catalog).
//
// Identical reasoning to scripts/check-im-lanes-mount.mjs, and deliberately the
// same shape: the promise rests on ONE deployment detail — the catalog is mounted
// as a WHOLE DIRECTORY. A subPath mount is replaced as a symlink the process
// never re-resolves, so the file changes on disk, the app keeps the old inode,
// and NOTHING ERRORS.
//
// Usage: node scripts/check-voice-catalog-mount.mjs [--manifest <path>]
// Exit:  0 ok / 1 violation / 2 cannot judge

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MANIFEST = process.env.VOICE_CATALOG_MANIFEST || null;
const MOUNT_NAME = "voice-catalog";
const MOUNT_PATH = "/etc/voice-catalog";

const args = process.argv.slice(2);
const manifestIdx = args.indexOf("--manifest");
const manifestPath = manifestIdx >= 0 ? args[manifestIdx + 1] : DEFAULT_MANIFEST;

if (!manifestPath) {
  console.error("cannot judge: no manifest given.");
  console.error("  pass --manifest <path> or set VOICE_CATALOG_MANIFEST (the platform Deployment");
  console.error("  manifest, or `kubectl -n <ns> get deploy platform -o yaml` output).");
  process.exit(2);
}
if (!fs.existsSync(manifestPath)) {
  console.error(`cannot judge: manifest not found at ${manifestPath}`);
  process.exit(2);
}

const lines = fs.readFileSync(manifestPath, "utf8").split("\n");

const findBlocks = () => {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s*name:\s*([\w.-]+)\s*$/.exec(lines[i]);
    if (!m || m[1] !== MOUNT_NAME) continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent < indent) break;
      if (lineIndent === indent && /^\s*-\s/.test(line)) break;
      block.push(line);
    }
    out.push({ line: i + 1, block });
  }
  return out;
};

const blocks = findBlocks();
if (!blocks.length) {
  console.error(`✗ no "${MOUNT_NAME}" entry found in ${path.basename(manifestPath)}`);
  console.error("  The catalog is not wired; the deployment runs on the image's catalog only.");
  process.exit(1);
}

const mounts = blocks.filter((b) => b.block.some((l) => /mountPath:/.test(l)));
if (!mounts.length) {
  console.error(`✗ "${MOUNT_NAME}" has a volume but no volumeMount (nothing lands in the container)`);
  process.exit(1);
}

let bad = 0;
for (const { line, block } of mounts) {
  if (block.some((l) => /^\s*subPath:/.test(l))) {
    bad += 1;
    console.error(`✗ ${MOUNT_NAME} (line ${line}) is mounted with subPath — hot update will NOT work`);
    console.error(`    Fix: mount the ConfigMap as a whole directory (mountPath: ${MOUNT_PATH}, no subPath).`);
  }
  const mountPath = block.map((l) => /mountPath:\s*(\S+)/.exec(l)?.[1]).find(Boolean);
  if (mountPath && mountPath !== MOUNT_PATH) {
    bad += 1;
    console.error(`✗ ${MOUNT_NAME} mounts at ${mountPath}; the app reads ${MOUNT_PATH}`);
  }
}
if (bad) process.exit(1);

const volume = blocks.find((b) => b.block.some((l) => /configMap:/.test(l)));
if (!volume) {
  console.error(`✗ "${MOUNT_NAME}" volume is not a ConfigMap — an emptyDir here would be silently empty`);
  process.exit(1);
}
if (volume.block.some((l) => /^\s*items:/.test(l))) {
  console.error(`✗ "${MOUNT_NAME}" volume carries an items: list`);
  console.error(`    The app reads ${MOUNT_PATH}/voice-catalog.json; an items list would map other keys`);
  console.error("    and the file would never appear (the catalog then reads as 'default' forever, silently).");
  process.exit(1);
}

console.log(
  `✓ ${MOUNT_NAME} is a whole-directory ConfigMap mount at ${MOUNT_PATH}` +
    " (hot update works: the next synthesis reads the new catalog, no restart, no image)",
);
