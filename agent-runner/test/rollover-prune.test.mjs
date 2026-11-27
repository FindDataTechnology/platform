// Archive retention (2026-11-25) — rollover used to only WRITE to archiveDir,
// so a pack that stopped serving grew forever. Measured on a production node: one retired
// pack reached 1.47 GB / 94 dated dirs on a 10 GB containerd disk at 82%.
//
// These tests pin the boundary that matters: dated entries older than the
// retention window go, everything inside the window stays, and anything that
// is not a dated entry is left alone (a human or another format may own it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rollover } from "../rollover.js";


function harness({ retainDays = 14, nowMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rollover-prune-"));
  const archiveDir = join(root, "archive");
  const homeRoot = join(root, "home");
  const r = new Rollover({
    manager: {},
    config: { archiveDir, homeRoot, tz: "UTC", archiveRetainDays: retainDays },
    log: { log() {}, warn() {} },
    now: () => nowMs,
  });
  return { r, archiveDir, homeRoot, root };
}

/** Make <archiveDir>/<key>/<name> as a file (digest) or dir (session copy). */
function seed(archiveDir, key, name, { dir = true } = {}) {
  const p = join(archiveDir, key, name);
  mkdirSync(join(archiveDir, key), { recursive: true }); // parent may not exist yet
  if (dir) mkdirSync(p, { recursive: true });
  else writeFileSync(p, "x");
  return p;
}

test("prune removes dated entries older than the window, keeps the rest", () => {
  const now = Date.UTC(2026, 10, 25); // 2026-11-25
  const { r, archiveDir } = harness({ retainDays: 14, nowMs: now });
  const key = "packs-A";

  const oldDir = seed(archiveDir, key, "20261001"); // 55 days old
  const oldMd = seed(archiveDir, key, "20261001.md", { dir: false });
  const edgeDir = seed(archiveDir, key, "20261111"); // exactly 14 days
  const freshDir = seed(archiveDir, key, "20261124");
  const freshMd = seed(archiveDir, key, "20261124.md", { dir: false });

  r.__pruneForTest(key);

  assert.equal(existsSync(oldDir), false, "stale dated dir must go");
  assert.equal(existsSync(oldMd), false, "stale digest .md must go with it");
  assert.equal(existsSync(edgeDir), true, "entry exactly at the window stays");
  assert.equal(existsSync(freshDir), true);
  assert.equal(existsSync(freshMd), true);
});

test("prune leaves non-dated entries alone", () => {
  const now = Date.UTC(2026, 10, 25);
  const { r, archiveDir } = harness({ retainDays: 1, nowMs: now });
  const key = "packs-B";
  const stray = seed(archiveDir, key, "notes", { dir: false });
  const nested = seed(archiveDir, key, "20260101", { dir: true });
  r.__pruneForTest(key);
  assert.equal(existsSync(stray), true, "a human's stray file is not ours to delete");
  assert.equal(existsSync(nested), false);
});

test("retainDays=0 disables pruning (pre-2026-11-25 behavior)", () => {
  const now = Date.UTC(2026, 10, 25);
  const { r, archiveDir } = harness({ retainDays: 0, nowMs: now });
  const key = "packs-C";
  const ancient = seed(archiveDir, key, "20200101");
  r.__pruneForTest(key);
  assert.equal(existsSync(ancient), true, "0 means off, never 'delete everything'");
});

test("a missing archive dir is not an error", () => {
  const { r } = harness({ retainDays: 7, nowMs: Date.now() });
  assert.doesNotThrow(() => r.__pruneForTest("packs-absent"));
});
