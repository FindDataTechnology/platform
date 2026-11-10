#!/usr/bin/env node
// ── Auto-named artifact attribution (browser-lane-service 产物路由) ──────────
//
// The shared browser service lets the CLI auto-name a snapshot into the shared
// root, then sweeps it into the CALLING cell's dir. Deciding "was this file
// produced by this call?" against a wall-clock instant is unsound: filesystem
// timestamps are floored to the FS tick (1-10ms on Linux, coarser on some
// overlay/tmpfs mounts). A fast call can therefore leave a file whose mtime
// reads EARLIER than the call's `sinceMs`; it is not adopted, it stays in the
// shared root, and the next cell's call sweeps it up — a cross-cell artifact
// leak, and exactly the CI-only flake seen on 2026-11-08 (macOS passed).
//
// These tests pin the two halves: the `before` name snapshot decides ownership
// regardless of the clock, and the mtime fallback still reproduces the failure
// when no snapshot is supplied.
//
//   node --test scripts/test-browser-lane-artifacts.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { adoptNewFiles, listArtifactNames } = await import("../lib/browser-lane-artifacts.js");

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "browser-lane-artifacts-"));
  const shared = join(root, "shared");
  const cellDir = join(root, "cells", "cell-a", "workspace", "browser");
  mkdirSync(shared, { recursive: true });
  return { root, shared, cellDir };
}

// A file the call just wrote, but stamped with an mtime one tick BEFORE the
// call started — what a floored filesystem clock hands back.
function writeFlooredFile(dir, name, sinceMs) {
  const p = join(dir, name);
  writeFileSync(p, "PNG");
  const floored = (sinceMs - 6) / 1000;
  utimesSync(p, floored, floored);
  return p;
}

test("a floored mtime does not strand the artifact when the caller snapshotted the root", () => {
  const { shared, cellDir } = workspace();
  const sinceMs = Date.now();
  const before = listArtifactNames(shared); // empty: nothing there before the call
  writeFlooredFile(shared, "auto-1.png", sinceMs);

  adoptNewFiles({ root: shared, into: cellDir, sinceMs, before });

  assert.deepEqual(readdirSync(cellDir), ["auto-1.png"]);
  assert.ok(!readdirSync(shared).includes("auto-1.png"), "nothing may stay in the shared root");
});

test("without a snapshot the clock still decides — the CI failure reproduced", () => {
  // This is the pre-fix behaviour, kept as the counter-proof: the same file is
  // NOT adopted when ownership is inferred from `sinceMs` alone.
  const { shared, cellDir } = workspace();
  const sinceMs = Date.now();
  writeFlooredFile(shared, "auto-2.png", sinceMs);

  adoptNewFiles({ root: shared, into: cellDir, sinceMs });

  assert.deepEqual(readdirSync(cellDir), [], "mtime-based adoption misses it by design");
  assert.ok(readdirSync(shared).includes("auto-2.png"), "…and it stays in the shared root");
});

test("a file that was already there is not adopted", () => {
  const { shared, cellDir } = workspace();
  writeFileSync(join(shared, "earlier.png"), "PNG");
  const before = listArtifactNames(shared);
  const sinceMs = Date.now();

  adoptNewFiles({ root: shared, into: cellDir, sinceMs, before });

  assert.deepEqual(readdirSync(cellDir), []);
  assert.ok(readdirSync(shared).includes("earlier.png"));
});

test("a same-name collision in the cell dir gets a numeric suffix, never an overwrite", () => {
  const { shared, cellDir } = workspace();
  mkdirSync(cellDir, { recursive: true });
  writeFileSync(join(cellDir, "auto-3.png"), "EXISTING");
  const before = listArtifactNames(shared);
  const sinceMs = Date.now();
  writeFlooredFile(shared, "auto-3.png", sinceMs);

  adoptNewFiles({ root: shared, into: cellDir, sinceMs, before });

  assert.deepEqual(readdirSync(cellDir).sort(), ["auto-3-1.png", "auto-3.png"]);
  assert.equal(readFileSync(join(cellDir, "auto-3.png"), "utf8"), "EXISTING", "the earlier file must survive");
});

test("directories in the shared root are never adopted", () => {
  const { shared, cellDir } = workspace();
  mkdirSync(join(shared, "some-dir"), { recursive: true });
  const before = listArtifactNames(shared);
  adoptNewFiles({ root: shared, into: cellDir, sinceMs: Date.now(), before });
  assert.deepEqual(readdirSync(cellDir), []);
});
