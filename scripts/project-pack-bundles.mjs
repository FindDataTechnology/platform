#!/usr/bin/env node
// ── Project pack snapshots into the three envelopes (change
//    add-pack-bundle-projection, tasks 3.1–3.3)
//
// ONE source (`packs/projections.json` — immutable manifest snapshots), three
// outputs. Nothing here reads the database, the market, or the network: a drift
// gate has to be reconstructible from the repo alone, or it is a check of the
// build machine's luck.
//
//   packs/projections.json
//     { "packs": [ { "packId", "version", "manifest": {...} } ] }
//
//   ──► bundles/manifest.json            the bakery's list ({file, sha256})
//   ──► packs/bundles/*.yizpack         platform envelope (full manifest)
//   ──► packs/dsh-bundles/<id>/         cross-harness envelope (skills+presets)
//
// An ABSENT source list means zero packs, which means zero output — the same
// state the installer ships today (byte-identical build). Adding the first pack
// is a deliberate edit with a diff.
//
// Usage:
//   node scripts/project-pack-bundles.mjs            write outputs
//   node scripts/project-pack-bundles.mjs --check    verify disk matches source; exit 1 on drift
//   node scripts/project-pack-bundles.mjs --root <dir>   operate on a fixture tree (tests)

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "../server/offline-bundle.js";
import {
  projectManifestToIR,
  droppedSections,
  validateProjectionBoundary,
  checkDshCompat,
  toYizpackEnvelope,
  toDshBundle,
  toDesktopPresetManifest,
  DEFAULT_DSH_COMPAT,
} from "../server/pack-projection.js";

const SOURCE = path.join("packs", "projections.json");
const LIST = path.join("bundles", "manifest.json");
// NOT `resources/bundles/`: that is the bakery's DESTINATION, and it is rebuilt
// (rm -rf) before copying — a source living there would be deleted by the very
// step that bakes it. Sources live under packs/, which no build step clears.
const YIZPACK_DIR = path.join("packs", "bundles");
// Artifacts, not runtime resources: `resources/` is copied into the image and
// read at runtime (preset bundles), while these two envelopes are things a
// consumer TAKES AWAY. Keeping them under packs/ keeps "shipped in the image"
// and "carried out of it" separate.
const DSH_DIR = path.join("packs", "dsh-bundles");

const MATRIX_VERSION = "0.2.0-rc.2"; // dsh-matrix/package.json pin; the range check reads it below

function readMatrixVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "dsh-matrix", "package.json"), "utf8"));
    const pinned = pkg?.dependencies?.["@deepseek-ai/dsh"] ?? pkg?.devDependencies?.["@deepseek-ai/dsh"];
    return typeof pinned === "string" && pinned.trim() ? pinned.trim() : MATRIX_VERSION;
  } catch {
    return MATRIX_VERSION;
  }
}

function fail(message, problems = []) {
  console.error(`[project-bundles] FAILED: ${message}`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

function loadSources(root) {
  const file = path.join(root, SOURCE);
  if (!existsSync(file)) return [];
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`${SOURCE} is not valid JSON: ${err.message}`);
  }
  const packs = Array.isArray(doc?.packs) ? doc.packs : [];
  return packs;
}

function assertSources(packs, { matrixVersion, dshCompat }) {
  const problems = [];
  const seen = new Set();
  for (const [i, pack] of packs.entries()) {
    const at = `packs[${i}]`;
    if (!pack || typeof pack.packId !== "string" || !pack.packId.trim()) {
      problems.push(`${at}: packId is required`);
      continue;
    }
    if (!Number.isInteger(Number(pack.version))) {
      problems.push(`${at}: version must be an integer`);
      continue;
    }
    const key = `${pack.packId}@${Number(pack.version)}`;
    if (seen.has(key)) problems.push(`${at}: ${key} is listed twice`);
    seen.add(key);

    const boundary = validateProjectionBoundary(pack.manifest);
    for (const err of boundary) problems.push(`${key}: ${err.path ? `${err.path}: ` : ""}${err.error}`);

    const compat = checkDshCompat({ range: dshCompat, matrixVersion });
    if (!compat.ok) problems.push(`${key}: ${compat.reason}`);
  }
  if (problems.length > 0) fail(`${problems.length} projection problem(s)`, problems);
}

/** Everything the generator would write, as bytes — the only place that decides. */
async function buildOutputs(packs, { dshCompat }) {
  const yizpack = new Map(); // repo-relative path → Buffer
  const dsh = new Map(); // repo-relative path → string
  const listed = [];

  for (const pack of packs) {
    const version = Number(pack.version);
    const base = `${pack.packId}-v${version}`;
    const bytes = await toYizpackEnvelope(
      { packId: pack.packId, version, manifest: pack.manifest },
      { buildBundle },
    );
    const rel = path.join(YIZPACK_DIR, `${base}.yizpack`);
    yizpack.set(rel, Buffer.from(bytes));
    listed.push({ file: rel, bytes });

    const ir = projectManifestToIR(pack.manifest, { dshCompat });
    const dropped = droppedSections(pack.manifest);
    if (dropped.length > 0) {
      // Honest, not silent: the envelope ships less than the pack declares, and
      // the build log is where that fact belongs.
      console.log(`[project-bundles] ${pack.packId}@${version}: dropped ${dropped.join(", ")} (not capability)`);
    }
    const { files, packageJson } = toDshBundle(ir);
    const dir = path.join(DSH_DIR, base);
    dsh.set(path.join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    for (const [p, body] of Object.entries(files)) dsh.set(path.join(dir, p), body);
  }

  const manifest = toDesktopPresetManifest(listed);
  const listText = `${JSON.stringify(manifest, null, 2)}\n`;
  return { yizpack, dsh, listText };
}

async function main(argv) {
  const root = (() => {
    const i = argv.indexOf("--root");
    return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  })();
  const check = argv.includes("--check");

  const dshCompat = DEFAULT_DSH_COMPAT;
  const matrixVersion = readMatrixVersion(root);
  const packs = loadSources(root);
  assertSources(packs, { matrixVersion, dshCompat });

  const { yizpack, dsh, listText } = await buildOutputs(packs, { dshCompat });

  if (check) {
    const drift = [];
    const onDisk = (rel) => {
      const abs = path.join(root, rel);
      return existsSync(abs) ? readFileSync(abs) : null;
    };

    for (const [rel, bytes] of yizpack) {
      const current = onDisk(rel);
      if (!current || !current.equals(bytes)) drift.push(`envelope yizpack — ${rel} (${path.basename(rel, ".yizpack")})`);
    }
    for (const [rel, body] of dsh) {
      const current = onDisk(rel);
      if (!current || current.toString("utf8") !== body) {
        // Name the SKILL/preset the way an operator looks for it.
        const skill = /skills\/([^/]+)\//.exec(rel.replace(/\\/g, "/"))?.[1];
        drift.push(`envelope dsh — ${rel}${skill ? ` (skill ${skill})` : ""}`);
      }
    }
    // Zero packs means the installer ships no starter bundles, and the honest
    // state for that is "no list file at all" — the shape this repo already
    // builds today. A list left behind from a removed pack is drift.
    const currentList = onDisk(LIST);
    const expectsList = JSON.parse(listText).bundles.length > 0;
    if (expectsList) {
      if (!currentList || currentList.toString("utf8") !== listText) {
        drift.push(`envelope desktop — ${LIST} (regenerate)`);
      }
    } else if (currentList) {
      drift.push(`envelope desktop — ${LIST} (stale: no pack declares a bundle)`);
    }
    // Stale outputs (source shrank, files left behind) are drift too: a bundle
    // nobody can account for would still be baked and shipped.
    for (const dir of [YIZPACK_DIR, DSH_DIR]) {
      const abs = path.join(root, dir);
      if (!existsSync(abs)) continue;
      const expected = new Set(dir === YIZPACK_DIR ? [...yizpack.keys()] : [...dsh.keys()]);
      for (const name of readdirSync(abs, { recursive: true })) {
        const rel = path.join(dir, String(name));
        if (existsSync(path.join(root, rel)) && !expected.has(rel) && /\.(yizpack|json|md)$/.test(rel)) {
          drift.push(`stale output — ${rel}`);
        }
      }
    }

    if (drift.length === 0) {
      console.log(`[project-bundles] clean — ${packs.length} pack(s), no drift`);
      return 0;
    }
    console.error(`[project-bundles] ${drift.length} drift(s) (run without --check to regenerate):`);
    for (const d of drift) console.error(`  · ${d}`);
    return 1;
  }

  // Write mode: outputs are rebuilt from the source, so a removed pack cannot
  // leave a stale envelope behind.
  for (const dir of [YIZPACK_DIR, DSH_DIR]) {
    rmSync(path.join(root, dir), { recursive: true, force: true });
  }
  for (const [rel, bytes] of yizpack) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), bytes);
  }
  for (const [rel, body] of dsh) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  mkdirSync(path.dirname(path.join(root, LIST)), { recursive: true });
  writeFileSync(path.join(root, LIST), listText);
  console.log(
    `[project-bundles] wrote ${yizpack.size} yizpack + ${dsh.size} dsh file(s) from ${packs.length} pack(s)`,
  );
  return 0;
}

process.exit(await main(process.argv.slice(2)));
