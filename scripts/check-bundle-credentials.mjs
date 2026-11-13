#!/usr/bin/env node
// ── Platform credential surface check (harden-plugin-supply-gates, task 3.1) ─
//
// The runbook's S6 axis ("zero platform credential material") used to be a human
// reading a candidate's container env before approval. A human check does not
// run on every build, and the thing it protects is not a candidate but the
// DEPLOYMENT: a bundle that reaches a platform credential can call the registry,
// mint supply tokens or reach the gateway as us.
//
// So the axis becomes a build gate. Scope, deliberately narrow to stay honest:
//
//   · scanned: the DECLARATIONS that get composed into every profile — the
//     profile template's package.json and patch layers, plus the supply manifest
//     and each sample bundle's package.json;
//   · not scanned: bridge SOURCE (.js). Those files legitimately read env at
//     runtime (that is their job) and are reviewed code, not declarations.
//     Scanning them would produce noise, and a noisy gate gets switched off.
//
// Exit code: 0 clean, 1 any hit (with file + path), 2 usage error. The message
// names the file, the field path and the key, because "failed" alone sends
// someone reading logs instead of fixing the declaration.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  PLATFORM_CREDENTIAL_KEY_NAMES,
  PLATFORM_CREDENTIAL_KEY_PREFIXES,
  isPlatformCredentialKey,
} from "../lib/platform-credential-keys.js";

// Credential material that must never appear in a supply declaration. Names,
// not patterns: a broad `*TOKEN*` match would flag legitimate fields (a bot
// token belongs to the OPERATOR's bot row, not to a bundle) and lose the gate.
export const PLATFORM_CREDENTIAL_KEYS = PLATFORM_CREDENTIAL_KEY_NAMES;


function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Walk a parsed document looking for credential key names at any depth.
 * @returns {{path: string, key: string}[]}
 */
export function scanForCredentialKeys(value, at = "") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      hits.push(...scanForCredentialKeys(item, `${at}[${i}]`));
    });
    return hits;
  }
  if (!isPlainObject(value)) return hits;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = at ? `${at}.${key}` : key;
    const upper = key.toUpperCase();
    // A key whose name IS a credential name, or one that starts with a
    // credential prefix (LLM_PROVIDER_KEY_<ID> is the documented user-provider
    // form) is a hit.
    if (isPlatformCredentialKey(key)) {
      const matched =
        PLATFORM_CREDENTIAL_KEY_NAMES.find((known) => upper === known) ??
        PLATFORM_CREDENTIAL_KEY_PREFIXES.find((prefix) => upper === prefix || upper.startsWith(`${prefix}_`)) ??
        upper;
      hits.push({ path: keyPath, key: matched });
    }
    hits.push(...scanForCredentialKeys(child, keyPath));
  }
  return hits;
}

/** Parse a file by extension; returns {doc} or {error}. */
export function readDeclaration(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { error: `unreadable (${err?.message || err})` };
  }
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === ".yml" || ext === ".yaml") return { doc: yaml.load(raw) };
    if (ext === ".json") return { doc: JSON.parse(raw) };
  } catch (err) {
    return { error: `unparsable (${err?.message || err})` };
  }
  return { error: "unsupported extension (only .json/.yml/.yaml declarations are scanned)" };
}

/** Collect the default scan set for a repo root. */
export function defaultTargets(repoRoot) {
  const targets = [];
  const templateDir = path.join(repoRoot, "dsh-profile-template");
  for (const name of ["package.json", "cordis.yml", "cordis.patch.yml"]) {
    const file = path.join(templateDir, name);
    if (existsSync(file)) targets.push(file);
  }
  const supplyManifest = path.join(repoRoot, "dsh-matrix", "plugin-supply.json");
  if (existsSync(supplyManifest)) targets.push(supplyManifest);
  // The exception ledger is operator-written and can name almost anything, so it
  // is scanned on the same terms as the supply declaration.
  const routeExceptions = path.join(repoRoot, "dsh-matrix", "route-exceptions.json");
  if (existsSync(routeExceptions)) targets.push(routeExceptions);
  const samples = path.join(repoRoot, "dsh-matrix", "samples");
  if (existsSync(samples)) {
    for (const entry of readdirSync(samples)) {
      const pkg = path.join(samples, entry, "package.json");
      if (existsSync(pkg) && statSync(pkg).isFile()) targets.push(pkg);
    }
  }
  return targets;
}

/** Scan a list of declaration files. @returns {{file: string, path: string, key: string}[]} */
export function scanFiles(files) {
  const hits = [];
  for (const file of files) {
    const parsed = readDeclaration(file);
    if (parsed.error) {
      hits.push({ file, path: "", key: `<${parsed.error}>` });
      continue;
    }
    for (const hit of scanForCredentialKeys(parsed.doc)) hits.push({ file, ...hit });
  }
  return hits;
}

function usage(code = 0) {
  console.log(`usage: node scripts/check-bundle-credentials.mjs [--root <repo>] [--file <declaration> ...]

Scans the declarations that compose into every profile (profile template
package.json + patch layers, supply manifest, sample bundle package.json) for
platform credential key names. Exit 1 on any hit.`);
  process.exit(code);
}

function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i]);
    else if (argv[i] === "--file") extra.push(path.resolve(argv[++i]));
    else if (argv[i] === "--help" || argv[i] === "-h") usage(0);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      usage(2);
    }
  }
  const targets = [...defaultTargets(root), ...extra];
  const hits = scanFiles(targets);
  if (hits.length === 0) {
    console.log(`[bundle-credentials] clean — ${targets.length} declaration(s) scanned`);
    return 0;
  }
  console.error(`[bundle-credentials] ${hits.length} hit(s) — platform credential material in a supply declaration:`);
  for (const hit of hits) {
    const where = hit.path ? `${hit.file} → ${hit.path}` : hit.file;
    console.error(`  · ${where} (${hit.key})`);
  }
  console.error("[bundle-credentials] a bundle may never carry platform credential material (runbook S6).");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
