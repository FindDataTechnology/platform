#!/usr/bin/env node
// ── Supply-declaration check (harden-plugin-supply-gates, tasks 4.1 / 4.2) ──
//
// Two files have to agree before a bundle can be composed into a profile:
//
//   · `dsh-profile-template/package.json` → `dsh.profile.bundles` — what actually
//     gets composed, in order;
//   · `dsh-matrix/plugin-supply.json` → `bundles[].contributes` — what that bundle
//     is reviewed to contribute.
//
// Neither direction is assumed. A composed bundle with no declaration is an
// UNREVIEWED bundle (not "harmless"), and a declared bundle that composes nowhere
// is dead bookkeeping that will rot into a lie. The classes themselves are
// validated by `lib/plugin-contribution-spec.js`, including the v1 refusal of
// `tool` (no MCP server key ⇒ no tool-face gate can bound it).
//
// Upstream dsh bundles (the `@deepseek-ai/…` base closure) are exempt from the
// declaration requirement: they are the runtime itself, reviewed upstream, and
// pinning a contribution taxonomy onto them would be theatre. The exemption is
// a prefix, declared here once.
//
// Exit: 0 clean, 1 violation (named), 2 usage.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSupplyManifest, allowedClassesOf } from "../lib/plugin-contribution-spec.js";
import { loadRouteExceptions } from "../lib/route-exceptions.js";

/** Bundles that belong to the dsh runtime itself, not to our supply decisions. */
export const UPSTREAM_BUNDLE_PREFIXES = ["@deepseek-ai/"];

export function isUpstreamBundle(name) {
  return UPSTREAM_BUNDLE_PREFIXES.some((prefix) => String(name).startsWith(prefix));
}

function readJson(file) {
  try {
    return { doc: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { error: `unreadable or unparsable (${err?.message || err})` };
  }
}

/**
 * Cross-check the supply declaration against the composed bundle list.
 * @returns {{error: string}[]}
 */
export function checkSupplyAgreement({ template, supply }) {
  const errors = [];

  const composed = template?.dsh?.profile?.bundles;
  if (!Array.isArray(composed)) {
    errors.push({ error: "dsh-profile-template/package.json has no dsh.profile.bundles array" });
    return errors;
  }

  const declaredEntries = Array.isArray(supply?.bundles) ? supply.bundles : [];
  const declared = new Map(declaredEntries.map((entry) => [entry?.name ?? entry?.id, entry]));

  for (const name of composed) {
    if (typeof name !== "string" || !name) continue;
    if (isUpstreamBundle(name)) continue;
    if (!declared.has(name)) {
      errors.push({
        error: `bundle '${name}' is composed in the profile template but has no contribution declaration in plugin-supply.json (an undeclared bundle is unreviewed, not harmless)`,
      });
    }
  }

  for (const [name, entry] of declared) {
    if (!name) continue;
    if (!composed.includes(name)) {
      errors.push({
        error: `bundle '${name}' is declared in plugin-supply.json but composed nowhere in the profile template (dead declaration)`,
      });
    }
    if (allowedClassesOf(entry).length === 0) {
      errors.push({ error: `bundle '${name}' declares no permitted contribution class` });
    }
  }

  return errors;
}

/**
 * The exception ledger is checked at build time too (task 4.3): a malformed
 * entry would otherwise fail silently at runtime as "grants nothing", and an
 * expired entry would sit there looking like permission nobody revoked.
 * @returns {{error: string}[]}
 */
export function checkRouteExceptions(root, { now = Date.now() } = {}) {
  const file = path.join(root, "dsh-matrix", "route-exceptions.json");
  const loaded = loadRouteExceptions(file);
  const errors = loaded.errors.map((error) => ({ error }));
  if (!existsSync(file)) return errors; // absent ledger = no exceptions, still valid
  for (const exception of loaded.exceptions) {
    if (Number.isFinite(exception?.expiresAt) && exception.expiresAt <= now) {
      errors.push({
        error: `route exception for '${exception.name}' expired at ${new Date(exception.expiresAt).toISOString()} — re-review it or remove the entry (an expired exception is dead paperwork)`,
      });
    }
  }
  return errors;
}

function main(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let root = repoRoot;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node scripts/check-plugin-supply.mjs [--root <repo>]");
      return 0;
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      return 2;
    }
  }

  const templateFile = path.join(root, "dsh-profile-template", "package.json");
  const supplyFile = path.join(root, "dsh-matrix", "plugin-supply.json");
  if (!existsSync(templateFile)) {
    console.error(`[plugin-supply] missing ${templateFile}`);
    return 1;
  }
  // An absent supply manifest with a non-upstream bundle composed is a violation,
  // not a pass — that ordering is the whole point.
  const template = readJson(templateFile);
  if (template.error) {
    console.error(`[plugin-supply] ${templateFile}: ${template.error}`);
    return 1;
  }
  const supply = existsSync(supplyFile) ? readJson(supplyFile) : { doc: { bundles: [] } };
  if (supply.error) {
    console.error(`[plugin-supply] ${supplyFile}: ${supply.error}`);
    return 1;
  }

  const errors = [
    ...validateSupplyManifest(supply.doc),
    ...checkSupplyAgreement({ template: template.doc, supply: supply.doc }),
    ...checkRouteExceptions(root),
  ];
  if (errors.length === 0) {
    const count = Array.isArray(supply.doc.bundles) ? supply.doc.bundles.length : 0;
    console.log(`[plugin-supply] clean — ${count} declared bundle(s), agreement with the profile template holds`);
    return 0;
  }
  console.error(`[plugin-supply] ${errors.length} violation(s):`);
  for (const err of errors) console.error(`  · ${err.entry ? `${err.entry}: ` : ""}${err.error}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
