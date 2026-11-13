#!/usr/bin/env node
// ── Delete-through-symlink guard (dsh-profile.js linkProfilePinnedModules) ───
//
// linkProfilePinnedModules() "clears stale leftovers" in the profile's module
// dir and links the pinned packages in. Both moves are path operations, and a
// path is not a location: when a component between the module dir and the entry
// is a symlink, `<moduleDir>/@deepseek-ai/<pkg>` names a directory in ANOTHER
// install, so `rmSync` deletes there and `symlinkSync` writes there.
//
// That is not hypothetical. On 2026-11-11 the developer's
// ~/.dsh/profiles/platform/node_modules/@deepseek-ai was found EMPTY — every
// pinned package gone — after a unit run whose own home was a temp dir. The
// only trace in the log was four assertion failures in an unrelated suite
// ("Cannot read properties of undefined (reading 'slice')"), because a
// half-populated shared install fails deep inside the dsh child, never at the
// line that did the damage.
//
// This suite pins the guard from both sides:
//   1. a symlinked `@deepseek-ai` pointing at a decoy install → NOTHING in the
//      decoy may be deleted or written, the link must stay a link, and the real
//      ~/.dsh must be byte-for-byte the same set of paths;
//   2. the same code path on a REAL directory → the links are still created, so
//      the guard cannot quietly turn the feature off.
//
//   node --test scripts/test-dsh-profile-link-guard.mjs

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The developer's real home, captured BEFORE HOME is redirected: the guard test
// asserts this tree is untouched, and it must not be the tree under test.
const REAL_HOME = process.env.HOME || "";

const TMP = mkdtempSync(path.join(tmpdir(), "dsh-link-guard-"));

// dsh-profile.js reads homedir() and $DSH_HOME at MODULE LOAD, so everything
// below has to be in place before the dynamic import at the bottom.
const FAKE_HOME = path.join(TMP, "home");
mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.DSH_HOME = path.join(TMP, "dsh-home");
// Deliberately absent: the suite must not borrow anything from a real shared
// tree (that is what made the original accident possible).
process.env.DSH_SHARED_HOME = path.join(FAKE_HOME, ".dsh");

// A stand-in runtime tree. DSH_BIN's path is parsed for `/node_modules/` to find
// this root, and the pinned packages are sourced from it.
const RUNTIME_MODULES = path.join(TMP, "runtime", "node_modules");
const DSH_BIN = path.join(RUNTIME_MODULES, "@deepseek-ai", "dsh", "bin.js");
const PINNED = ["schemastery", "dsh-session", "dsh-tools", "dsh-sdk-jsonrpc-server"];
for (const pkg of PINNED) {
  const dir = path.join(RUNTIME_MODULES, "@deepseek-ai", pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${pkg}`, version: "0.0.0-runtime" }));
}
mkdirSync(path.dirname(DSH_BIN), { recursive: true });
writeFileSync(DSH_BIN, "// test runtime entry\n");
process.env.DSH_BIN = DSH_BIN;

// The DECOY install: real directories behind a symlink — the exact shape whose
// contents went missing from ~/.dsh.
const DECOY_SCOPE = path.join(TMP, "other-install", "@deepseek-ai");
for (const pkg of PINNED) {
  const dir = path.join(DECOY_SCOPE, pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SENTINEL"), `must survive: ${pkg}\n`);
}

const MODULE_DIR = path.join(process.env.DSH_HOME, "profiles", "platform", "node_modules");
mkdirSync(MODULE_DIR, { recursive: true });
const SCOPE_LINK = path.join(MODULE_DIR, "@deepseek-ai");
symlinkSync(DECOY_SCOPE, SCOPE_LINK, "dir");

// Path-set snapshot (no mtimes): the damage this guards against is deletion and
// creation. Mtimes are left out on purpose — another process legitimately
// touching the tree must not make this red, while a vanished package must.
//
// Depth 6, not 4: the 2026-11-11 damage lived at
// .dsh/profiles/platform/node_modules/@deepseek-ai/<pkg> — the SIXTH path
// component — so a shallower walk would have compared two identical sets and
// called it clean. Package dirs are symlinks, so the deeper walk costs ~5 extra
// entries, not thousands.
function snapshot(root, maxDepth = 6) {
  const out = new Set();
  const walk = (dir, depth, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      out.add(childRel);
      if (depth < maxDepth && e.isDirectory()) walk(path.join(dir, e.name), depth + 1, childRel);
    }
  };
  walk(root, 1, "");
  return out;
}

const before = snapshot(path.join(REAL_HOME, ".dsh"));
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.join(" "));
  realWarn(...args);
};

const { ensureDshHome } = await import("../dsh-profile.js");
ensureDshHome();

console.warn = realWarn;

after(() => rmSync(TMP, { recursive: true, force: true }));

test("a symlinked scope directory is never deleted or written through", () => {
  for (const pkg of PINNED) {
    const dir = path.join(DECOY_SCOPE, pkg);
    assert.ok(existsSync(path.join(dir, "SENTINEL")), `the decoy's ${pkg} was deleted THROUGH the symlink`);
    assert.ok(lstatSync(dir).isDirectory(), `the decoy's ${pkg} was replaced — a write went through the symlink`);
    // Nothing may be ADDED on the far side either: a symlinkSync through the
    // link would leave the runtime link sitting in somebody else's install.
    assert.deepEqual(
      readdirSync(dir),
      ["SENTINEL"],
      `the decoy's ${pkg} gained entries — the link creation wrote through the symlink`,
    );
  }
  assert.ok(lstatSync(SCOPE_LINK).isSymbolicLink(), "the scope link must stay a symlink");
  assert.equal(readlinkSync(SCOPE_LINK), DECOY_SCOPE, "the scope link must still point at the decoy");

  // The guard has to SAY it refused: a silent skip is indistinguishable from a
  // no-op and would let the same accident happen again unnoticed.
  const refused = warnings.filter((w) => w.includes("delete-through-symlink guard"));
  assert.ok(refused.length > 0, `expected the guard to refuse at least once, saw: ${JSON.stringify(warnings)}`);
  assert.ok(
    refused.some((w) => w.includes("@deepseek-ai/")),
    `the refusal must name the entry it skipped: ${JSON.stringify(refused)}`,
  );
});

test("the developer's real ~/.dsh is untouched by this suite", () => {
  if (!existsSync(path.join(REAL_HOME, ".dsh"))) {
    console.log("[dsh-link-guard] no ~/.dsh on this machine — nothing to compare");
    return;
  }
  const after = snapshot(path.join(REAL_HOME, ".dsh"));
  const removed = [...before].filter((p) => !after.has(p));
  const added = [...after].filter((p) => !before.has(p));
  assert.deepEqual(removed, [], `this suite REMOVED paths from the real ~/.dsh: ${removed.slice(0, 10).join(", ")}`);
  assert.deepEqual(added, [], `this suite CREATED paths in the real ~/.dsh: ${added.slice(0, 10).join(", ")}`);
});

test("on a real module directory the pinned links are still created (the guard does not disable the feature)", () => {
  // Turn the scope component into a real directory: the legitimate path.
  rmSync(SCOPE_LINK); // removes the LINK, not the decoy
  mkdirSync(SCOPE_LINK, { recursive: true });
  ensureDshHome();

  for (const pkg of PINNED) {
    const link = path.join(SCOPE_LINK, pkg);
    assert.ok(existsSync(link), `${pkg} was not linked`);
    assert.ok(lstatSync(link).isSymbolicLink(), `${pkg} must be a symlink into the runtime tree`);
    assert.equal(
      readlinkSync(link),
      path.join(RUNTIME_MODULES, "@deepseek-ai", pkg),
      `${pkg} must point at the runtime tree, not the app tree`,
    );
  }
  // …and the decoy is STILL intact after the legitimate run.
  for (const pkg of PINNED) {
    assert.ok(existsSync(path.join(DECOY_SCOPE, pkg, "SENTINEL")), `second run deleted the decoy's ${pkg}`);
  }
});
