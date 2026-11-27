#!/usr/bin/env node
// check-im-lanes-mount: the hot-update promise must not be a lie.
//
// The IM lane data layer (externalize-im-platform-adapters) promises that
// changing a sentence of group copy costs no image and no restart. That promise
// rests entirely on ONE deployment detail: the config must be mounted as a WHOLE
// DIRECTORY.
//
// A single-file `subPath` mount is replaced by kubelet as a symlink swap the
// process never re-resolves — the file on disk changes, the running process keeps
// reading the old inode, and NOTHING ERRORS. That silence is why this check
// exists: without it, someone "tidies" the mount into subPath, the config layer
// keeps claiming hot reload, and everyone concludes "the feature is buggy".
//
// Usage: node scripts/check-im-lanes-mount.mjs [--manifest <path>]
// Exit:  0 ok / 1 violation / 2 cannot judge
//
// It works on a file — the deployment manifest, or `kubectl get deploy -o yaml`
// output — so it runs in CI without a cluster.

import fs from "node:fs";
import path from "node:path";

// The deployment manifest lives in a SEPARATE, private repo. This checker ships
// publicly, so it must not name that repo or assume a sibling checkout: supply
// the path explicitly (--manifest) or via env, and refuse to guess.
//
//   node scripts/check-im-lanes-mount.mjs --manifest <platform.yaml>
//   IM_LANES_MANIFEST=<platform.yaml> node scripts/check-im-lanes-mount.mjs
const DEFAULT_MANIFEST = process.env.IM_LANES_MANIFEST || null;

const MOUNT_NAME = "im-lanes";
const MOUNT_PATH = "/etc/im-lanes";

const args = process.argv.slice(2);
const manifestIdx = args.indexOf("--manifest");
const manifestPath = manifestIdx >= 0 ? args[manifestIdx + 1] : DEFAULT_MANIFEST;

if (!manifestPath) {
  console.error("cannot judge: no manifest given.");
  console.error("  pass --manifest <path> or set IM_LANES_MANIFEST (the platform Deployment");
  console.error("  manifest, or `kubectl -n <ns> get deploy platform -o yaml` output).");
  process.exit(2);
}

if (!fs.existsSync(manifestPath)) {
  console.error(`cannot judge: manifest not found at ${manifestPath}`);
  process.exit(2);
}

const text = fs.readFileSync(manifestPath, "utf8");
const lines = text.split("\n");

// A tiny structural scan rather than a YAML parser: this repo has no YAML
// dependency and the shape we need is two sibling list entries under known keys.
// Being explicit about what we look for is also what makes the failure message
// actionable.
const findMountBlock = () => {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s*name:\s*([\w.-]+)\s*$/.exec(lines[i]);
    if (!m || m[1] !== MOUNT_NAME) continue;
    // Collect the sibling keys of this list entry (until the next `- name:` at
    // the same or shallower indentation).
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
    out.push({ line: i + 1, block, indent });
  }
  return out;
};

const blocks = findMountBlock();
if (!blocks.length) {
  console.error(`✗ no "${MOUNT_NAME}" entry found in ${path.basename(manifestPath)}`);
  console.error("  The IM lane config is not wired; the data layer would run on image defaults only.");
  process.exit(1);
}

// Two entries are expected: the volumeMount (has mountPath) and the volume
// (has configMap). Both are "- name: im-lanes"; only the mount is checked here.
const mounts = blocks.filter((b) => b.block.some((l) => /mountPath:/.test(l)));
if (!mounts.length) {
  console.error(`✗ "${MOUNT_NAME}" has a volume but no volumeMount (nothing lands in the container)`);
  process.exit(1);
}

let bad = 0;
for (const { line, block } of mounts) {
  const hasSubPath = block.some((l) => /^\s*subPath:/.test(l));
  const mountPath = block.map((l) => /mountPath:\s*(\S+)/.exec(l)?.[1]).find(Boolean);
  if (hasSubPath) {
    bad += 1;
    console.error(`✗ ${MOUNT_NAME} (line ${line}) is mounted with subPath — hot update will NOT work`);
    console.error(`    mountPath: ${mountPath}`);
    console.error("    A subPath mount is replaced as a symlink the process never re-resolves:");
    console.error("    the file changes on disk, the app keeps reading the old inode, and nothing errors.");
    console.error(`    Fix: mount the ConfigMap as a whole directory (mountPath: ${MOUNT_PATH}, no subPath).`);
  }
  if (mountPath && mountPath !== MOUNT_PATH) {
    bad += 1;
    console.error(`✗ ${MOUNT_NAME} mounts at ${mountPath}; the app reads ${MOUNT_PATH}`);
    console.error("    Either the mount path or IM_LANES_DIR must change — silently they already disagree.");
  }
}

if (bad) process.exit(1);

const volume = blocks.find((b) => b.block.some((l) => /configMap:/.test(l)));
if (!volume) {
  console.error(`✗ "${MOUNT_NAME}" volume is not a ConfigMap — an emptyDir here would be silently empty`);
  process.exit(1);
}

// `items` is the OTHER way this silently breaks. An items list maps named keys to
// paths; if the im-lanes volume inherits someone else's list (a copy-paste from
// line-manifests is the real case, 2026-11-19), the mount directory exists but the
// file the app reads never appears — and nothing errors. The config layer then
// reports source:"default" forever, which is indistinguishable from "not mounted".
if (volume.block.some((l) => /^\s*items:/.test(l))) {
  console.error(`✗ "${MOUNT_NAME}" volume carries an items: list`);
  console.error("    An items list maps specific ConfigMap keys to paths; the app reads");
  console.error(`    ${MOUNT_PATH}/im-lanes.json. In practice this means the volume inherited`);
  console.error("    another ConfigMap's generated items block, so the file never appears and the");
  console.error('    config layer reports source:"default" forever — silently.');
  console.error("    Fix: drop items (the whole ConfigMap is mounted by key name).");
  process.exit(1);
}

console.log(
  `✓ ${MOUNT_NAME} is a whole-directory ConfigMap mount at ${MOUNT_PATH}` +
    " (hot update works: next turn reads the new file, no restart, no image)",
);
