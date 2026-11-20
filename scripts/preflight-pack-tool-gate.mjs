#!/usr/bin/env node
// ── Republish pre-flight for the pack tool-face gate ────────────────────────
//
// pack-tool-declaration-gate task 2.5. Run this against the AUTHORING repo's
// regenerated manifests BEFORE the first republish wave. It answers the two
// questions a wave can fail on:
//
//   1. Does every reference carry an explicit tool face, and does every tool a
//      skill names sit inside its declaration? (pure functions — always run)
//   2. Can the registry actually confirm the declared names? (snapshot
//      coverage + one live probe per server; needs REGISTRY_URL)
//
// Exit code 0 = no violations and no UNRESOLVED names; 1 = wave blockers.
//
//   REGISTRY_URL=https://registry.example node scripts/preflight-pack-tool-gate.mjs \
//     ~/finddata/docs/*-presets/pack-manifests
//
// Without REGISTRY_URL the registry half is skipped and reported as such.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  declaredToolsByServer,
  toolFaceErrors,
  toolClosureErrors,
  probeMcpToolNames,
} from "../lib/publish-tool-gate.js";
import { registryServerIndex } from "../registry-bridge.js";

function manifestFiles(targets) {
  const files = [];
  for (const target of targets) {
    const st = statSync(target);
    if (st.isDirectory()) {
      for (const name of readdirSync(target)) {
        if (name.endsWith(".json")) files.push(path.join(target, name));
      }
    } else if (target.endsWith(".json")) {
      files.push(target);
    }
  }
  return files.sort();
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (targets.length === 0) {
  console.error("usage: node scripts/preflight-pack-tool-gate.mjs <dir-or-manifest.json ...>");
  process.exit(2);
}

const files = manifestFiles(targets);
const manifests = [];
for (const file of files) {
  try {
    manifests.push({ file, manifest: JSON.parse(readFileSync(file, "utf8")) });
  } catch (err) {
    console.error(`[preflight] unreadable manifest ${file}: ${err.message}`);
    process.exitCode = 1;
  }
}

// ── 1. Tool face + closure (pure, always) ───────────────────────────────────
let faceViolations = 0;
for (const { file, manifest } of manifests) {
  for (const err of [...toolFaceErrors(manifest), ...toolClosureErrors(manifest)]) {
    faceViolations += 1;
    console.log(`[face] ${path.basename(file)}: ${err.error}`);
  }
}

// ── 2. Registry confirmation (snapshot + probe) ─────────────────────────────
const registryConfigured = Boolean(String(process.env.MARKET_REGISTRY_URL || process.env.REGISTRY_URL || "").trim());
// The bridge reads ONLY MARKET_REGISTRY_TOKEN. A REGISTRY_TOKEN-only setup
// silently 401s and used to print a false-green `unresolved=0` — call it out.
const registryTokenSet = Boolean(String(process.env.MARKET_REGISTRY_TOKEN || "").trim());
if (registryConfigured && !registryTokenSet && String(process.env.REGISTRY_TOKEN || "").trim()) {
  console.warn(
    "[preflight] REGISTRY_TOKEN is set but MARKET_REGISTRY_TOKEN is NOT — the registry bridge reads only " +
      "MARKET_REGISTRY_TOKEN; this run will 401 and the registry half stays unverified",
  );
}
let registryVerified = false;
const perServer = new Map(); // server → { declared:Set, packs:Set }
for (const { file, manifest } of manifests) {
  for (const [server, names] of declaredToolsByServer(manifest)) {
    if (!perServer.has(server)) perServer.set(server, { declared: new Set(), packs: new Set() });
    const row = perServer.get(server);
    row.packs.add(path.basename(file));
    for (const name of names) row.declared.add(name);
  }
}

let unresolved = 0;
if (!registryConfigured) {
  console.log("[preflight] REGISTRY_URL/MARKET_REGISTRY_URL unset — registry confirmation SKIPPED");
} else {
  let index;
  try {
    index = await registryServerIndex();
    registryVerified = true;
  } catch (err) {
    console.error(
      `[preflight] registry unreachable/unauthorized (${err?.message || err}); ` +
        `set MARKET_REGISTRY_TOKEN (or use a token-bearing REGISTRY_URL) and rerun`,
    );
    process.exitCode = 1;
    index = new Map();
  }
  for (const [server, row] of perServer) {
    const info = index.get(server) ?? null;
    if (!info) {
      // Only a VERIFIED index may call a name "local-binding exempt"; an
      // unavailable index means the registry half did not run at all.
      console.log(
        `[registry] ${server}: ` +
          `${registryVerified ? "not a registry entry (local-binding exempt)" : "UNVERIFIED (registry index unavailable)"}` +
          ` — ${row.declared.size} declared`,
      );
      continue;
    }
    const snapshot = Array.isArray(info.toolList) ? info.toolList : [];
    const missing = [...row.declared].filter((t) => !snapshot.includes(t));
    let probeState = "not needed";
    if (missing.length > 0) {
      const probed = info.endpoint ? await probeMcpToolNames(info.endpoint) : null;
      if (Array.isArray(probed)) {
        const still = missing.filter((t) => !probed.includes(t));
        probeState = still.length === 0 ? "confirmed by probe" : `probe still missing: ${still.join(", ")}`;
        if (still.length > 0) unresolved += still.length;
      } else {
        probeState = "probe unavailable (UNRESOLVED — refresh the snapshot)";
        unresolved += missing.length;
      }
    }
    console.log(
      `[registry] ${server}: snapshot=${snapshot.length} declared=${row.declared.size} ` +
        `missing=${missing.length ? missing.join(", ") : "-"} probe=${probeState}`,
    );
  }
}

// Three honest states: skipped (no registry configured), unknown (configured
// but the index could not be fetched — never a pass), verified (real count).
const unresolvedState = !registryConfigured
  ? "skipped (no registry URL)"
  : registryVerified
    ? String(unresolved)
    : "unknown (registry NOT verified)";
console.log(
  `\n[preflight] manifests=${manifests.length} servers=${perServer.size} ` +
    `faceViolations=${faceViolations} unresolved=${unresolvedState}`,
);
if (faceViolations > 0 || (registryConfigured && (!registryVerified || unresolved > 0))) {
  process.exitCode = 1;
}
