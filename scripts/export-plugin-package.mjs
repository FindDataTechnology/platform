#!/usr/bin/env node
// scripts/export-plugin-package.mjs — export a pack manifest to an Agent
// Plugins 1.0 directory, offline (openspec: add-pack-raven-export, task 3.3).
//
// No database, no network, no host config: a manifest file in, a directory out.
// This exists so the export can run on a machine that is not a cell — and so the
// determinism criterion has an entry point a script can drive end to end.
//
// The three steps are the SAME three every other envelope uses (see the header of
// server/pack-projection.js): decide the boundary, project to the IR, serialise
// one envelope. Reading the manifest directly here would be a fourth place that
// answers "what may leave", which is the thing the IR exists to prevent.
//
//   node scripts/export-plugin-package.mjs <manifest.json> <outdir> [--pack-id <id>]
//
// `--pack-id` mirrors the publish route's `req.body.packId`: an already-known id
// (a published pack, or a caller that needs two exports to stay distinguishable).
// Without it the package id derives from the manifest name exactly as the publish
// route derives it — which is `draft-pack` for a CJK-only name, never "pack".

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  droppedSections,
  projectManifestToIR,
  toAgentPluginsPackage,
  validateProjectionBoundary,
} from "../server/pack-projection.js";
import { writePluginPackage } from "../server/plugin-package-write.js";

function usage(code = 2) {
  process.stderr.write(
    "usage: export-plugin-package.mjs <manifest.json> <outdir> [--pack-id <id>]\n",
  );
  process.exit(code);
}

const positional = [];
let packId;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--pack-id") {
    packId = process.argv[i + 1];
    if (!packId) usage();
    i += 1;
  } else {
    positional.push(arg);
  }
}
const [manifestPath, outDir] = positional;
if (!manifestPath || !outDir) usage();

let manifest;
try {
  manifest = JSON.parse(readFileSync(path.resolve(manifestPath), "utf8"));
} catch (err) {
  process.stderr.write(`cannot read manifest: ${err.message}\n`);
  process.exit(2);
}

const boundary = validateProjectionBoundary(manifest);
if (boundary.length > 0) {
  for (const err of boundary) {
    process.stderr.write(`error: ${err.path ? `${err.path}: ` : ""}${err.error}\n`);
  }
  process.exit(1);
}

let built;
try {
  built = toAgentPluginsPackage(projectManifestToIR(manifest), {
    dropped: droppedSections(manifest),
    ...(packId ? { packId } : {}),
  });
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}

try {
  const target = await writePluginPackage(built.files, outDir);
  process.stdout.write(`${target}\n${Object.keys(built.files).length} file(s)\n`);
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
