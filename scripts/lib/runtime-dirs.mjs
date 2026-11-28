// runtime-dirs.mjs — the single source of the runtime DIRECTORIES the desktop
// installer must pack (desktop-catch-up-release).
//
// Two consumers, one list:
//   - electron-builder.js generates its positive files-list entries from it
//   - scripts/verify-bundle.js proves every project-relative spawn path in
//     supervisor/descriptors.js lands inside this list and exists on disk
//
// The bug class this closes has three shipped instances: a runtime directory
// referenced by code but absent from the packaging file list —
//   2026-10-07  lib/       packaged app died on ERR_MODULE_NOT_FOUND at boot
//   v1.3.10     services/  exe died on "Cannot find services/search-relay/scoped-token.js"
//   v1.3.13     agent-runner/ (probable) fleet seat spawn fails after pairing
// Root-level runtime FILES (server.js, paths.js, *.json data) ride the files
// list's file globs and are out of this list's scope.

import fs from "node:fs";
import path from "node:path";

export const RUNTIME_DIRS = [
  "lib", // shared server-side modules (2026-10-07 lesson)
  "server", // HTTP/WS routes and server modules
  "gateway", // gateway wiring
  "services", // late-joining service runtimes (v1.3.10 lesson)
  "agent-runner", // desktop fleet seat runner — supervisor descriptor spawn (v1.3.13 lesson)
  "dsh-profile-template", // dsh profile scaffold + bridge plugin, materialized at runtime
  "electron", // desktop shell: main / preload / preferences
  "supervisor", // child-process supervisor + descriptors
  "bootstrap", // first-run bootstrap
  // server-side imports of the core workspace package (role recipes/surfaces,
  // imported as .ts and run on the bundled Node ≥23's type stripping) — caught
  // by the v1.3.18 local dist boot smoke, would have bricked the installer.
  // (Note: server/routes/bots.js's "../bots/…" resolves INSIDE server/** —
  // relative import paths resolve from the importing file, not the root.)
  "packages",
];

// Descriptor-referenced directories that ride DEDICATED files-list entries of
// their own (node_modules/**, public/**, web/dist/**, skills/**) rather than
// the RUNTIME_DIRS-generated block. The coverage gate accepts either set —
// what it refuses is a referenced directory with NO packing path at all.
export const PACKED_ELSEWHERE_DIRS = ["node_modules", "public", "web", "skills"];

// Supervisor descriptors spawn children with project-relative entry paths:
//   args: [path.join(projectRoot, "agent-runner", "index.js")]
// Extract every such reference as { kind: "dir"|"file", name } — a multi-segment
// path's first segment is a directory, a single segment is a root file.
export function descriptorSpawnRefs(source) {
  const refs = [];
  const seen = new Set();
  const re = /path\.join\(\s*projectRoot\s*,\s*(?:"([^"]+)"|'([^']+)')/g;
  for (let m = re.exec(String(source ?? "")); m; m = re.exec(String(source ?? ""))) {
    const first = (m[1] ?? m[2]).split("/")[0];
    if (!first || seen.has(first)) continue;
    seen.add(first);
    refs.push({ kind: first.includes(".") ? "file" : "dir", name: first });
  }
  return refs;
}

// The gate verify-bundle runs before packing: every descriptor-referenced
// directory must be a RUNTIME_DIRS member (hence in the files list) and every
// referenced entry must exist in the build tree. Returns problem strings; an
// empty array means the packaged tree will cover the descriptor spawn graph.
export function runtimeDirCoverageProblems({ root, descriptorSource }) {
  const covered = new Set([...RUNTIME_DIRS, ...PACKED_ELSEWHERE_DIRS]);
  const problems = [];
  for (const ref of descriptorSpawnRefs(descriptorSource)) {
    if (ref.kind === "dir" && !covered.has(ref.name)) {
      problems.push(
        `supervisor descriptor spawns ${ref.name}/… but it is in neither RUNTIME_DIRS nor PACKED_ELSEWHERE_DIRS (scripts/lib/runtime-dirs.mjs) — the installer would omit it`,
      );
    }
    if (!fs.existsSync(path.join(root, ref.name))) {
      problems.push(`descriptor-referenced ${ref.kind} missing from the build tree: ${ref.name}`);
    }
  }
  for (const d of RUNTIME_DIRS) {
    if (!fs.existsSync(path.join(root, d))) {
      problems.push(`RUNTIME_DIRS entry missing from the build tree: ${d}`);
    }
  }
  return problems;
}
