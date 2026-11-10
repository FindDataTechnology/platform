#!/usr/bin/env node
// ── Bake offline starter bundles into the installer (predist step) ──────────
// (add-offline-pack-supply, installer seeding.)
//
// Controlled list → resources/bundles/. The list is `bundles/manifest.json`
// ({ "bundles": [{ "file": "<repo-relative .yizpack path>" }] }); absent or
// empty means the installer ships NO bundles and every other build step stays
// byte-identical.
//
// Discipline the spec pins:
//   - idempotent: the destination directory is rebuilt from the list, so a
//     repeated build never accumulates stale entries;
//   - fail fast: every candidate is fully re-validated (zip shape, digests,
//     path safety) HERE, so a corrupt bundle breaks the build instead of
//     surfacing on a user's machine;
//   - no back door: the import surface treats these exactly like a user-picked
//     file (same endpoint, same gates) — this step only puts bytes on disk.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBundle } from "../server/offline-bundle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listPath = path.join(root, "bundles", "manifest.json");
const destDir = path.join(root, "resources", "bundles");

function fail(message) {
  console.error(`[bake-bundles] FAILED: ${message}`);
  process.exit(1);
}

let entries = [];
if (existsSync(listPath)) {
  try {
    const doc = JSON.parse(readFileSync(listPath, "utf8"));
    entries = Array.isArray(doc?.bundles) ? doc.bundles : [];
  } catch (e) {
    fail(`bundles/manifest.json is not valid JSON: ${e.message}`);
  }
}

// Rebuild the destination from the list (idempotent, no stale accumulation).
rmSync(destDir, { recursive: true, force: true });

if (entries.length === 0) {
  console.log("[bake-bundles] no starter bundles listed — installer ships none (zero-change build)");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
const seen = new Set();
for (const entry of entries) {
  const rel = typeof entry === "string" ? entry : entry?.file;
  if (!rel || typeof rel !== "string") fail(`bad list entry: ${JSON.stringify(entry)}`);
  const src = path.resolve(root, rel);
  if (!src.startsWith(root + path.sep)) fail(`list entry escapes the repo: ${rel}`);
  if (!existsSync(src) || !statSync(src).isFile()) fail(`listed bundle is missing: ${rel}`);
  const name = path.basename(src);
  if (seen.has(name)) fail(`two listed bundles share the file name ${name}`);
  seen.add(name);

  // Full integrity re-check before it can reach an installer.
  const bytes = readFileSync(src);
  let parsed;
  try {
    parsed = await readBundle(bytes);
  } catch (e) {
    fail(`${rel} is not a valid bundle (${e.code || "error"}): ${e.message}`);
  }
  copyFileSync(src, path.join(destDir, name));
  console.log(`[bake-bundles] ${parsed.meta.packId} v${parsed.meta.version} → resources/bundles/${name}`);
}

const shipped = readdirSync(destDir).filter((f) => f.endsWith(".yizpack")).sort();
console.log(`[bake-bundles] ${shipped.length} bundle(s) baked: ${shipped.join(", ")}`);
