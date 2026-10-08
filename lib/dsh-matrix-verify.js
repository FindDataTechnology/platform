// dsh-matrix-verify.js — the boot-time hard gate for the dsh install matrix
// (add-dsh-matrix-lock, design D5; ADR-0007).
//
// Compares what is ACTUALLY installed under the install root against the
// frozen truth in dsh-matrix/package-lock.json. The historical failure mode
// this gate exists for: a rebuilt image silently resolved a different
// transitive/peer closure and the cell only failed later, mid-session, with
// ERR_MODULE_NOT_FOUND (2026-09-23 hmr crash-loop class). The gate moves that
// discovery to process start, with a package-level diff in the log.
//
// Pure host-side code by construction: imports only node builtins, never any
// @deepseek-ai package — it must be able to diagnose the very tree it checks.
//
// Semantics (specs/dsh-version-matrix):
//   - install root absent            → skip (local dev machines, e2e scratch)
//   - diff empty                     → pass
//   - diff non-empty + override env  → pass with the report retained in logs
//   - diff non-empty + no override   → fail (caller exits before serving)
//
// Lock indexing: every entry of lock `packages` (lockfileVersion 3) except the
// root "" entry contributes its name → version. Nested entries
// ("node_modules/a/node_modules/b") are legal npm output for version
// conflicts; a name is "present" if ANY installed instance anywhere in the
// tree matches ANY version the lock records for it. Only TOP-LEVEL installed
// packages can be "extra" — nested packages under a scoped dependency are
// part of that dependency's own closure, not the deployment's surface.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_WALK_DEPTH = 6;

function lockName(lockKey) {
  // "node_modules/@deepseek-ai/dsh" → "@deepseek-ai/dsh"
  // "node_modules/a/node_modules/b" → "b" (last segment wins)
  const idx = lockKey.lastIndexOf("node_modules/");
  return idx === -1 ? null : lockKey.slice(idx + "node_modules/".length);
}

function readInstalledVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

// Walk node_modules directories collecting every installed instance,
// top-level first: returns { top: Map<name, version|null>, all: Map<name, Set<version>> }.
function inventoryTree(installRoot) {
  const top = new Map();
  const all = new Map();
  const record = (name, version, isTop) => {
    if (!all.has(name)) all.set(name, new Set());
    if (version) all.get(name).add(version);
    if (isTop) top.set(name, version);
  };
  const walk = (nmDir, depth, isTopLevel) => {
    if (depth > MAX_WALK_DEPTH || !existsSync(nmDir)) return;
    let entries;
    try {
      entries = readdirSync(nmDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === ".bin" || ent.name.startsWith(".")) continue;
      if (ent.name.startsWith("@")) {
        for (const sub of readdirSync(join(nmDir, ent.name), { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const pkgDir = join(nmDir, ent.name, sub.name);
          record(`${ent.name}/${sub.name}`, readInstalledVersion(pkgDir), isTopLevel);
        }
      } else {
        const pkgDir = join(nmDir, ent.name);
        record(ent.name, readInstalledVersion(pkgDir), isTopLevel);
        walk(join(pkgDir, "node_modules"), depth + 1, false);
      }
    }
    // scoped trees can nest too
    if (isTopLevel) {
      for (const ent of entries) {
        if (!ent.isDirectory() || !ent.name.startsWith("@")) continue;
        for (const sub of readdirSync(join(nmDir, ent.name), { withFileTypes: true })) {
          walk(join(nmDir, ent.name, sub.name, "node_modules"), depth + 1, false);
        }
      }
    }
  };
  walk(join(installRoot, "node_modules"), 0, true);
  return { top, all };
}

// The diff. skipped is set when there is nothing to check against (no install
// root — a dev machine, or an e2e-run scratch environment).
export function diffMatrixTree(lockPath, installRoot) {
  if (!existsSync(installRoot)) return { skipped: true, ok: true, extra: [], missing: [], mismatch: [], report: "" };
  if (!existsSync(lockPath)) {
    return {
      skipped: false,
      ok: false,
      extra: [],
      missing: [],
      mismatch: [],
      report: `[dsh-matrix] lock not found at ${lockPath} while install root ${installRoot} exists — refusing to verify nothing`,
    };
  }

  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  // Platform-gated optional deps (sharp/koffi/landlock ship one binary per
  // os+cpu) are locked for EVERY platform but installed only for the current
  // one — an off-platform entry is npm's normal behavior, not drift.
  const platformMatches = (pkg) => {
    const os = pkg.os;
    const cpu = pkg.cpu;
    if (os && !os.includes(process.platform)) return false;
    if (cpu && !cpu.includes(process.arch)) return false;
    return true;
  };
  const lockIndex = new Map(); // name → Set(versions)
  for (const key of Object.keys(lock.packages ?? {})) {
    if (key === "") continue;
    const entry = lock.packages[key];
    if (!platformMatches(entry)) continue;
    const name = lockName(key);
    const version = entry.version;
    if (!name || !version) continue;
    if (!lockIndex.has(name)) lockIndex.set(name, new Set());
    lockIndex.get(name).add(version);
  }

  const { top, all } = inventoryTree(installRoot);
  const extra = []; // top-level installed but unknown to the lock
  const mismatch = []; // installed instance at a version the lock never records
  const missing = []; // lock entry with no installed instance anywhere

  for (const [name, version] of top) {
    if (!lockIndex.has(name)) extra.push({ name, version });
  }
  for (const [name, versions] of all) {
    if (!lockIndex.has(name)) continue; // already reported as extra if top-level
    for (const v of versions) {
      if (!lockIndex.get(name).has(v)) mismatch.push({ name, version: v });
    }
  }
  for (const [name] of lockIndex) {
    if (!all.has(name)) missing.push({ name, expected: [...lockIndex.get(name)].join(" | ") });
  }

  const ok = extra.length === 0 && mismatch.length === 0 && missing.length === 0;
  const lines = [];
  if (!ok) {
    lines.push(`[dsh-matrix] installed tree at ${installRoot} deviates from ${lockPath}:`);
    for (const m of missing) lines.push(`  missing:  ${m.name} (lock: ${m.expected})`);
    for (const m of mismatch) lines.push(`  mismatch: ${m.name}@${m.version} (lock has: ${[...(lockIndex.get(m.name) ?? [])].join(" | ")})`);
    for (const e of extra) lines.push(`  extra:    ${e.name}@${e.version ?? "?"}`);
  }
  return { skipped: false, ok, extra, missing, mismatch, report: lines.join("\n") };
}

// Boot gate wrapper shared by server.js and agent-runner. Returns the action
// the caller should take; the caller owns process.exit so logs/flush behave
// per its own conventions.
export function matrixGate({ lockPath, installRoot, override = process.env.DSH_MATRIX_OVERRIDE }) {
  const diff = diffMatrixTree(lockPath, installRoot);
  if (diff.skipped) return { action: "skip", diff };
  if (diff.ok) return { action: "pass", diff };
  if (override) return { action: "override", diff };
  return { action: "fail", diff };
}
