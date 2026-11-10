// packaged-tree.mjs — the packaged node_modules classifier shared by
// electron-builder.js's afterPack and scripts/verify-bundle.js.
//
// electron-builder's collector walks dependencies+optionalDependencies but
// NEVER peerDependencies. The 0.2.0 dsh graph reaches ~64 foundation/plugin
// packages exclusively via peers, and those carry their own unscoped deps —
// none of which the collector ships (v1.3.9 exe crashed on
// "@deepseek-ai/dsh-sdk-protocol" on clean machines; debug run 38554132682).
// afterPack therefore syncs the tree verbatim minus a DEV-ONLY set, computed
// here as a fixpoint:
//
//   ships₀ = @deepseek-ai scope ∪ hard-closure(root.dependencies)
//   shipsₙ₊₁ = shipsₙ ∪ { P in tree : some Q ∈ shipsₙ requires P (hard/opt/peer) }
//   devOnly = tree top-level − ships∞   (minus the prune list, handled by callers)
//
// The fixpoint is the safety property itself: nothing in devOnly is required
// by anything that ships. Dev trees (electron, electron-builder, playwright…)
// never enter ships because nothing in ships requires them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function listTopLevel(nmDir) {
  const out = [];
  if (!existsSync(nmDir)) return out;
  for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = join(nmDir, entry.name);
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (sub.isDirectory() && existsSync(join(scopeDir, sub.name, "package.json"))) {
          out.push(`${entry.name}/${sub.name}`);
        }
      }
    } else if (existsSync(join(nmDir, entry.name, "package.json"))) {
      out.push(entry.name);
    }
  }
  return out;
}

export function computePackagedTree({ nmDir, rootPkg }) {
  const top = listTopLevel(nmDir);
  const topSet = new Set(top);
  const readPkg = (name) => JSON.parse(readFileSync(join(nmDir, name, "package.json"), "utf8"));

  const requirers = new Map(); // dep → [top-level names requiring it]
  const note = (from, to) => {
    if (!topSet.has(to)) return;
    (requirers.get(to) ?? requirers.set(to, []).get(to)).push(from);
  };
  for (const name of top) {
    let p;
    try {
      p = readPkg(name);
    } catch {
      continue;
    }
    for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(p[kind] ?? {})) note(name, dep);
    }
  }

  // ships₀: the @deepseek-ai scope + the hard closure of root dependencies.
  const ships = new Set();
  const walkHard = (name) => {
    if (ships.has(name) || !topSet.has(name)) return;
    ships.add(name);
    let p;
    try {
      p = readPkg(name);
    } catch {
      return;
    }
    for (const dep of [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.optionalDependencies ?? {})]) {
      walkHard(dep);
    }
  };
  for (const name of top) {
    if (name.startsWith("@deepseek-ai/")) ships.add(name);
  }
  for (const name of Object.keys(rootPkg.dependencies ?? {})) walkHard(name);

  // Fixpoint: absorb everything a shipping package requires (incl. peers).
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of top) {
      if (ships.has(name)) continue;
      const rs = requirers.get(name);
      if (rs && rs.some((r) => ships.has(r))) {
        ships.add(name);
        grew = true;
      }
    }
  }

  const devOnly = top.filter((n) => !ships.has(n));
  return { ships, devOnly, top };
}
