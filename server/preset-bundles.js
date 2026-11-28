// ── Preinstalled starter bundles (add-offline-pack-supply + change 4) ───────
//
// The desktop installer may ship a few official starter bundles under
// `<resources>/bundles`. This module makes them VISIBLE and INSTALLABLE — but
// never installs them on its own: registering an importable source is not the
// same as installing a pack, and the spec keeps that line sharp (the user's
// explicit confirmation is still required).
//
// Two entry points, one truth:
//   listPresetBundles()   → what is on disk (metadata only, cheap)
//   importPresetBundle()  → the full path: read → verify digests → installPack
//                           (the SAME pipeline a market install uses)
//
// The directory resolves from PLATFORM_RESOURCES_DIR (the packaged app's
// resources root) and falls back to the repo's resources/ in dev. An empty or
// missing directory is a normal state, not an error.

import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { readBundle } from "./offline-bundle.js";
import { repoRoot } from "../paths.js";

export function presetBundlesDir(env = process.env) {
  const resources = String(env.PLATFORM_RESOURCES_DIR || "").trim();
  return resources ? path.join(resources, "bundles") : repoRoot("resources", "bundles");
}

// Metadata only: the zip's bundle.json is read without verifying the payloads
// (the list is a catalogue, not an import).
export async function listPresetBundles({ env = process.env } = {}) {
  const dir = presetBundlesDir(env);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".yizpack")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const zip = await JSZip.loadAsync(fs.readFileSync(file));
      const metaNode = zip.files["bundle.json"];
      if (!metaNode) continue;
      const meta = JSON.parse(await metaNode.async("string"));
      let name2 = null;
      try {
        const manifestNode = zip.files["manifest.json"];
        if (manifestNode) {
          const manifest = JSON.parse(await manifestNode.async("string"));
          name2 = manifest?.name ?? null;
        }
      } catch { /* the catalogue survives a broken manifest body */ }
      out.push({
        file: name,
        packId: meta.packId ?? null,
        version: meta.version ?? null,
        name: name2,
        origin: meta.origin ?? null,
        bytes: fs.statSync(file).size,
      });
    } catch {
      // A broken file is not a catalogue entry (the build already fails fast on
      // these; this only keeps a hand-edited directory from breaking the page).
    }
  }
  return out;
}

// The full import path — read → verify → install through the shared pipeline.
export async function importPresetBundle({ file, env = process.env, installPack, user = null, hooks = {} }) {
  const dir = presetBundlesDir(env);
  const safeName = path.basename(String(file ?? ""));
  if (!safeName || safeName !== String(file) || !safeName.endsWith(".yizpack")) {
    throw Object.assign(new Error("preset bundle name is invalid"), { status: 400, code: "preset_bad_name" });
  }
  const full = path.join(dir, safeName);
  if (!full.startsWith(path.join(dir, path.sep)) && !full.startsWith(dir + path.sep)) {
    throw Object.assign(new Error("preset bundle path escapes the bundles directory"), { status: 400, code: "preset_bad_path" });
  }
  let bytes;
  try {
    bytes = fs.readFileSync(full);
  } catch {
    throw Object.assign(new Error(`preset bundle ${safeName} is not on disk`), { status: 404, code: "preset_not_found" });
  }
  const { meta, manifest } = await readBundle(bytes);
  if (typeof installPack !== "function") {
    throw Object.assign(new Error("installer is unavailable"), { status: 503, code: "preset_no_installer" });
  }
  const { report, installed } = await installPack({
    packId: meta.packId,
    version: meta.version,
    manifest,
    user,
    confirm: true,
    source: "bundle",
    hooks,
  });
  return { report, installed, bundle: { file: safeName, packId: meta.packId, version: meta.version, origin: meta.origin ?? null } };
}
