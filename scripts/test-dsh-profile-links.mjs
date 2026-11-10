// Regression self-check for the profile bridge-package linking
// (dsh-profile.js → linkProfilePinnedModules).
//
// Two module trees exist in an image deployment and they must never be mixed:
//   * the RUNTIME tree — what DSH_BIN points at (/opt/dsh/node_modules, the
//     frozen matrix install the boot gate and dsh-contracts verify);
//   * the APP tree — this repo's own node_modules (the rc.5/rc.1 generation
//     the server itself runs on).
// The profile's bridge packages must resolve to ONE realpath. Linking the app
// tree's copies into a profile whose runtime is the matrix install gives the
// child two instances of dsh-tools — two TOOL_RUNTIME_SCHEDULER Symbols — and
// every tool call dies with "Cannot read properties of undefined (reading
// 'prepare')" (2026-10-09 prod roll sha-e956091). An earlier revision also
// mutated the deployment's frozen tree through the whole-tree symlink
// (image-publish 37847464206: four packages "resolving outside the candidate
// tree").
//
// This test pins the rules: never write into a deployment-provided module dir
// (not even to fill gaps), always link from the RUNTIME tree, heal the app-tree
// poison an earlier revision left behind, and keep the packaged-desktop
// behavior (no DSH_BIN → app tree IS the runtime).
//
// Runs entirely inside a temp DSH_HOME (set before the module loads, because
// dsh-profile resolves its paths at import time), so the developer's real
// ~/.dsh is never written.
//
// Run: node scripts/test-dsh-profile-links.mjs

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const PKGS = [
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-sdk-jsonrpc-server",
];

const root = mkdtempSync(path.join(tmpdir(), "dsh-profile-links-"));
const home = path.join(root, "home");
const runtime = path.join(root, "runtime"); // stands in for /opt/dsh
const shared = path.join(root, "shared"); // the deployment's profile module dir target

function plantTree(base, version) {
  for (const pkg of PKGS) {
    const dir = path.join(base, "node_modules", pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
  }
}
plantTree(runtime, "0.1.1-rc.2-matrix");
plantTree(shared, "0.1.1-rc.2-matrix");

process.env.DSH_HOME = home;
process.env.DSH_SHARED_HOME = path.join(root, "no-shared-home"); // ensureDshHome must not auto-link
process.env.DSH_BIN = path.join(runtime, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

const profileDir = path.join(home, "profiles", "platform");
const moduleDir = path.join(profileDir, "node_modules");
const profile = await import("../dsh-profile.js");

// ── case 1: deployment-provided whole-tree link (the image layout) ──────────
// The profile's module dir is a symlink into the deployment's tree: nothing
// may be written there, gaps included.
mkdirSync(profileDir, { recursive: true });
symlinkSync(path.join(shared, "node_modules"), moduleDir, "dir");
profile.ensureDshHome();
for (const pkg of PKGS) {
  const entry = path.join(shared, "node_modules", pkg);
  assert.ok(existsSync(entry), `${pkg}: frozen-tree entry survived`);
  assert.equal(lstatSync(entry).isSymbolicLink(), false, `${pkg}: frozen-tree entry was replaced by a symlink`);
  assert.equal(
    JSON.parse(readFileSync(path.join(entry, "package.json"), "utf8")).version,
    "0.1.1-rc.2-matrix",
    `${pkg}: frozen version intact`,
  );
}

// ── case 2: packaged desktop — profile dir without any tree link ────────────
// Nothing provides the profile's node_modules, so the app's own copies must be
// linked in or the child dies on the first bare import. With DSH_BIN set they
// come from the RUNTIME tree — the same realpath the child boots from.
rmSync(path.join(home, "profiles"), { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
profile.ensureDshHome();
for (const pkg of PKGS) {
  const link = path.join(moduleDir, pkg);
  assert.ok(lstatSync(link).isSymbolicLink(), `${pkg}: link created`);
  assert.equal(
    realpathSync(link),
    realpathSync(path.join(runtime, "node_modules", pkg)),
    `${pkg}: link points at the runtime tree, not the app tree`,
  );
}

// ── case 3: a stale real entry in OUR dir is still cleared and relinked ─────
rmSync(moduleDir, { recursive: true, force: true });
mkdirSync(path.join(moduleDir, PKGS[0]), { recursive: true }); // an earlier build's leftover
profile.ensureDshHome();
assert.ok(lstatSync(path.join(moduleDir, PKGS[0])).isSymbolicLink(), "stale real entry replaced with a link");

// ── case 4: the deployment's tree is never written to ──────────────────────
// A third-party symlink inside the frozen tree (damage from an earlier build)
// is left exactly as found: re-pointing it is the same write-through-the-link
// the rule exists to prevent. Real entries beside it stay untouched too.
rmSync(path.join(home, "profiles"), { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
symlinkSync(path.join(shared, "node_modules"), moduleDir, "dir");
const foreign = path.join(root, "foreign-dsh-tools");
mkdirSync(foreign, { recursive: true });
rmSync(path.join(shared, "node_modules", PKGS[0]), { recursive: true, force: true });
symlinkSync(foreign, path.join(shared, "node_modules", PKGS[0]), "dir");
profile.ensureDshHome();
assert.equal(
  realpathSync(path.join(shared, "node_modules", PKGS[0])),
  realpathSync(foreign),
  "foreign symlink left exactly as found",
);
assert.equal(
  lstatSync(path.join(shared, "node_modules", PKGS[1])).isSymbolicLink(),
  false,
  "sibling real entry untouched",
);

// ── case 5: app-tree poison in the deployment dir is healed ────────────────
// The pre-fix revision linked the absent bridge packages INTO the deployment's
// module dir, pointing at the app tree. Two copies of dsh-tools then existed
// (app rc.1 + matrix rc.2): two TOOL_RUNTIME_SCHEDULER Symbols, and every tool
// call died. The heal removes exactly those links — links elsewhere and real
// dirs stay.
rmSync(path.join(home, "profiles"), { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
plantTree(shared, "0.1.1-rc.2-matrix"); // rebuild the shared tree cleanly
symlinkSync(path.join(shared, "node_modules"), moduleDir, "dir");
rmSync(path.join(shared, "node_modules", PKGS[0]), { recursive: true, force: true });
symlinkSync(path.join(APP_NODE_MODULES, PKGS[0]), path.join(shared, "node_modules", PKGS[0]), "dir");
const notOurs = path.join(root, "not-ours");
mkdirSync(notOurs, { recursive: true });
rmSync(path.join(shared, "node_modules", PKGS[2]), { recursive: true, force: true });
symlinkSync(notOurs, path.join(shared, "node_modules", PKGS[2]), "dir");
profile.ensureDshHome();
assert.equal(existsSync(path.join(shared, "node_modules", PKGS[0])), false, "app-tree poison link removed");
assert.equal(realpathSync(path.join(shared, "node_modules", PKGS[2])), realpathSync(notOurs), "non-app symlink kept");
assert.equal(
  lstatSync(path.join(shared, "node_modules", PKGS[1])).isSymbolicLink(),
  false,
  "deployment's real entry kept",
);

// ── case 6: legacy cell — real module dir holding app-tree links ───────────
// The actual prod shape of 2026-10-09: an older cell whose profile module dir
// is a REAL directory (hand-installed dsh-base beside it) but which an earlier
// boot filled with app-tree links. Those links must be re-pointed at the
// RUNTIME tree, and the hand-installed entries we do not manage must survive.
rmSync(path.join(home, "profiles"), { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(path.join(moduleDir, "@deepseek-ai", "dsh-base"), { recursive: true }); // not ours
for (const pkg of [PKGS[1], PKGS[2]]) {
  mkdirSync(path.dirname(path.join(moduleDir, pkg)), { recursive: true });
  symlinkSync(path.join(APP_NODE_MODULES, pkg), path.join(moduleDir, pkg), "dir");
}
profile.ensureDshHome();
for (const pkg of [PKGS[1], PKGS[2]]) {
  assert.equal(
    realpathSync(path.join(moduleDir, pkg)),
    realpathSync(path.join(runtime, "node_modules", pkg)),
    `${pkg}: app-tree link re-pointed at the runtime tree`,
  );
}
assert.ok(existsSync(path.join(moduleDir, "@deepseek-ai", "dsh-base")), "unmanaged entry survives");

rmSync(root, { recursive: true, force: true });
console.log("dsh-profile links: 6/6 cases pass");
