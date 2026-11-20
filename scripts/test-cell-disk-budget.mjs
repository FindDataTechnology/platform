#!/usr/bin/env node
// ── Per-cell disk budget (budget-cell-disk-usage 2.1/2.2) ───────────────────
//
// Measured live 2026-11-09: a 30 GiB node hosting 48 cells, one tenant's
// workspace at 1051 MiB with no cap anywhere — the node sat on kubelet's
// eviction line and evicted facet (hostPath-pinned) for ~15 minutes.
//
// What is pinned here is the accounting contract, not a threshold taste:
//   - the budget knobs read sanely (defaults, and a hard cap never below soft);
//   - `ok` / `near` / `over` are three states, because two cannot say "stop
//     growing" before "stop working";
//   - measurement sums nested files and treats a missing directory as zero
//     (cells are created lazily; a status read must not fail because of it);
//   - symlinks are not followed, so one cell can never report another's bytes;
//   - readings are cached for a TTL — a polling console must not turn into 48
//     directory walks per request.
//
//   node --test --test-force-exit scripts/test-cell-disk-budget.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cell-disk-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const disk = await import("../gateway/cell-disk.js");

function writeFileAt(rel, bytes) {
  const full = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, 0x61));
  return full;
}

test("budget knobs: defaults, explicit values, and hard never below soft", () => {
  assert.deepEqual(disk.diskBudgets({}), disk.DISK_DEFAULTS);
  assert.deepEqual(disk.diskBudgets({ CELL_DISK_SOFT_MB: "100", CELL_DISK_HARD_MB: "300" }),
    { softBytes: 100 * 1024 * 1024, hardBytes: 300 * 1024 * 1024 });
  // A hard cap under the soft one would make `near` unreachable — clamp instead
  // of shipping a config that silently means something else.
  assert.deepEqual(disk.diskBudgets({ CELL_DISK_SOFT_MB: "500", CELL_DISK_HARD_MB: "100" }),
    { softBytes: 500 * 1024 * 1024, hardBytes: 500 * 1024 * 1024 });
  // Junk values fall back rather than disabling the budget.
  assert.deepEqual(disk.diskBudgets({ CELL_DISK_SOFT_MB: "abc", CELL_DISK_HARD_MB: "-1" }), disk.DISK_DEFAULTS);
});

test("three states: ok / near / over", () => {
  const b = { softBytes: 100, hardBytes: 200 };
  assert.equal(disk.classifyDisk(0, b), "ok");
  assert.equal(disk.classifyDisk(99, b), "ok");
  assert.equal(disk.classifyDisk(100, b), "near", "soft is inclusive");
  assert.equal(disk.classifyDisk(199, b), "near");
  assert.equal(disk.classifyDisk(200, b), "over", "hard is inclusive");
  assert.equal(disk.classifyDisk(-1, b), "ok", "a nonsense reading never reads as over");
});

test("measurement sums nested files and treats absence as zero", async () => {
  writeFileAt("cell-a/workspace/top.bin", 1000);
  writeFileAt("cell-a/workspace/deep/nested/deeper.bin", 2000);
  writeFileAt("cell-a/dsh/sessions/s1.bin", 500);

  assert.equal(await disk.measureDirBytes(path.join(TMP, "cell-a/workspace")), 3000);
  assert.equal(await disk.measureDirBytes(path.join(TMP, "cell-a/dsh/sessions")), 500);
  assert.equal(await disk.measureDirBytes(path.join(TMP, "cell-a/missing")), 0);
  assert.equal(await disk.measureDirBytes(path.join(TMP, "no-such-cell")), 0);
});

test("a symlink is counted as a link, never followed out of the cell", async () => {
  writeFileAt("outside/secret.bin", 4096);
  const link = path.join(TMP, "cell-b/workspace/link.bin");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(TMP, "outside/secret.bin"), link);

  const bytes = await disk.measureDirBytes(path.join(TMP, "cell-b/workspace"));
  assert.ok(bytes < 4096, `symlink must not contribute the target's bytes (got ${bytes})`);
});

test("the meter caches per cell and refreshes after the TTL", async () => {
  writeFileAt("cell-c/workspace/a.bin", 100);
  const root = path.join(TMP, "cell-c");
  let clock = 1_000_000;
  const meter = disk.createDiskMeter({
    ttlMs: 5_000,
    budgets: { softBytes: 10_000, hardBytes: 20_000 },
    now: () => clock,
  });

  const first = await meter.read(root);
  assert.equal(first.workspaceBytes, 100);
  assert.equal(first.totalBytes, 100);
  assert.equal(first.state, "ok");
  assert.equal(first.measuredAt, new Date(clock).toISOString());

  // Inside the TTL the reading is reused even though the tree grew.
  writeFileAt("cell-c/workspace/b.bin", 100);
  const cached = await meter.read(root);
  assert.equal(cached.workspaceBytes, 100, "cached inside the TTL");

  // Past the TTL it re-measures and the state moves.
  clock += 6_000;
  writeFileAt("cell-c/workspace/c.bin", 19_900);
  const fresh = await meter.read(root);
  assert.equal(fresh.totalBytes, 20_100);
  assert.equal(fresh.state, "over");

  assert.equal(meter.snapshot().length, 1);
  meter.invalidate(root);
  assert.equal(meter.snapshot().length, 0);
});
