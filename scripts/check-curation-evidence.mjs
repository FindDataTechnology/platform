#!/usr/bin/env node
// ── Curation-evidence gate (change add-curation-evidence-gate, 3.1 / 3.2 / 3.3)
//
// The plugin catalogue has NO HTTP write face: an entry is "listed" by editing
// `packs/plugin-catalog.json` (or the deployment's PLUGIN_CATALOG_FILE) and
// baking it into the image/installer. So the listing act IS a file write, and
// this gate is its rejection point — the same way the credential and supply
// gates judge the declarations that compose into every profile.
//
// What it refuses:
//   · an entry the deployment SUPPLIES (roster whitelist) whose evidence is
//     incomplete or expired — shipping it would present unreviewed material as
//     available;
//   · with `--all`, every catalogue entry, whether or not it is supplied.
//
// What it never does: write, fix, or infer. Evidence is a human (or external
// pipeline) artefact; a gate that guesses would be the thing it is meant to stop.
//
// Usage:
//   node scripts/check-curation-evidence.mjs                 supplied entries only
//   node scripts/check-curation-evidence.mjs --all           every catalogue entry
//   node scripts/check-curation-evidence.mjs --warn          print, exit 0 (deliberate escapement)
//   node scripts/check-curation-evidence.mjs --candidate <f> validate a PROPOSED catalogue
//   node scripts/check-curation-evidence.mjs --root <dir>    fixture tree (tests)
//
// Exit: 0 clean (or warn), 1 violations (named), 2 usage.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginCatalog } from "../server/plugin-catalog.js";
import { evidenceState } from "../lib/curation-evidence.js";

const UPSTREAM_PREFIX = "@deepseek-ai/";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The bundles this deployment supplies: the supply manifest + the profile template. */
export function suppliedBundleIds(root) {
  const ids = new Set();
  const supply = readJson(path.join(root, "dsh-matrix", "plugin-supply.json"));
  for (const entry of Array.isArray(supply?.bundles) ? supply.bundles : []) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (typeof name === "string" && name.trim() && !name.startsWith(UPSTREAM_PREFIX)) ids.add(name.trim());
  }
  const template = readJson(path.join(root, "dsh-profile-template", "package.json"));
  const bundles = template?.dsh?.profile?.bundles;
  for (const name of Array.isArray(bundles) ? bundles : []) {
    if (typeof name === "string" && name.trim() && !name.startsWith(UPSTREAM_PREFIX)) ids.add(name.trim());
  }
  return ids;
}

/**
 * Judge one catalogue against a supplied set.
 * @returns {{entry: string, state: string, problems: string[]}[]}  problems empty = fine
 */
export function judgeCatalogue({ plugins, supplied, all = false, today = new Date() }) {
  const out = [];
  for (const entry of Array.isArray(plugins) ? plugins : []) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (!id) continue;
    const isSupplied = supplied.has(id);
    if (!isSupplied && !all) continue;
    const { state, reasons } = evidenceState({ evidence: entry.evidence, species: entry.species ?? "plugin" }, { today });
    if (state === "complete") continue;
    const prefix = isSupplied ? "supplied entry" : "catalogued entry";
    out.push({
      entry: id,
      state,
      problems: reasons.length > 0 ? reasons : [`${prefix} has no evidence`],
    });
  }
  return out;
}

function main(argv) {
  const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
  };
  const flag = (name) => argv.includes(`--${name}`);
  const known = new Set(["--warn", "--all", "--help", "-h"]);
  const withValue = new Set(["--candidate", "--catalog", "--root"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (known.has(a)) continue;
    if (withValue.has(a)) {
      i++;
      continue;
    }
    console.error(`unknown argument: ${a}`);
    return 2;
  }
  if (flag("help") || flag("-h")) {
    console.log("usage: node scripts/check-curation-evidence.mjs [--all] [--warn] [--candidate <file>] [--catalog <file>] [--root <dir>]");
    return 0;
  }

  const root = path.resolve(arg("root") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const catalogFile = arg("candidate") ?? arg("catalog");
  // An absent catalogue is an honest empty one (the plugin tab renders its empty
  // state) — not a violation, and not a reason to build a file here.
  if (!catalogFile && !existsSync(path.join(root, "packs", "plugin-catalog.json"))) {
    console.log("[curation-evidence] no plugin catalogue in this tree — nothing to judge");
    return 0;
  }

  const env = catalogFile ? { PLUGIN_CATALOG_FILE: path.resolve(catalogFile) } : { PLUGIN_CATALOG_FILE: path.join(root, "packs", "plugin-catalog.json") };
  const { plugins } = loadPluginCatalog({ env });
  const supplied = suppliedBundleIds(root);
  const problems = judgeCatalogue({ plugins, supplied, all: flag("all") });

  if (problems.length === 0) {
    const scope = flag("all") ? `${plugins.length} catalogued` : `${plugins.filter((p) => supplied.has(p.id)).length} supplied`;
    console.log(`[curation-evidence] clean — ${scope} entry(ies) carry complete, unexpired evidence`);
    return 0;
  }

  const warn = flag("warn");
  const head = warn
    ? `[curation-evidence] WARN (--warn escapement, not blocking): ${problems.length} entry(ies) lack usable evidence`
    : `[curation-evidence] ${problems.length} entry(ies) cannot ship:`;
  console.error(head);
  for (const p of problems) {
    console.error(`  · ${p.entry} (${p.state})`);
    for (const reason of p.problems) console.error(`      ${reason}`);
  }
  if (warn) {
    console.error("[curation-evidence] --warn: this run does NOT block. Every call site (predist / Dockerfile / CI) runs WITHOUT it; do not add it back to ship unreviewed material.");
    return 0;
  }
  console.error("[curation-evidence] fix: add the missing evidence fields in the catalogue (docs/ecosystem-curation.md §7.3), or re-review an expired entry");
  return 1;
}

// Only run as a CLI. The judge is importable (the gate's own tests use it), and
// an unconditional process.exit() at import time would kill its importers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
