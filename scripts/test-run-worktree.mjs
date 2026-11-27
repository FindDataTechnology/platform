#!/usr/bin/env node
// ── Run workbench primitive tests (fleet-run-workbench 1.1–1.5 / 5.1–5.10) ──
//
// Every case constructs the defect it guards against and asserts the defect is
// visible, so a regression turns one of these red instead of surfacing as
// "two runs quietly shared a desk".
//
//   node --test scripts/test-run-worktree.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import { detectBackend, create, release, sweep, usageOf } from "../lib/run-worktree.js";

const run = promisify(execFile);

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function gitRepo() {
  const dir = await tmp("wb-repo");
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "T"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README"), "seed\n");
  await run("git", ["add", "README"], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

// ── 1.1 backend detection ────────────────────────────────────────────────────

test("1.1 a git repo detects as worktree, a plain dir as directory", async () => {
  const repo = await gitRepo();
  const plain = await tmp("wb-plain");
  assert.equal(await detectBackend({ base: repo }), "worktree");
  assert.equal(await detectBackend({ base: plain }), "directory");
});

test("1.1 a missing/invalid base reads as directory, never throws", async () => {
  assert.equal(await detectBackend({ base: path.join(os.tmpdir(), "does-not-exist-hopefully") }), "directory");
  assert.equal(await detectBackend({}), "directory");
  assert.equal(await detectBackend({ base: 42 }), "directory");
});

// ── 1.2 create ───────────────────────────────────────────────────────────────

test("1.2 directory backend creates the workbench dir", async () => {
  const dataRoot = await tmp("wb-data");
  const wb = await create({ base: dataRoot, run: "run-1", dataRoot, backend: "directory" });
  assert.equal(wb.backend, "directory");
  assert.equal(wb.workbenchRef, "run-1");
  assert.equal((await fs.stat(wb.cwd)).isDirectory(), true);
});

test("1.2 worktree backend creates a detached worktree at baseRef", async () => {
  const repo = await gitRepo();
  const dataRoot = await tmp("wb-data");
  const wb = await create({ base: repo, run: "run-wt", dataRoot, backend: "worktree" });
  assert.equal((await fs.stat(wb.cwd)).isDirectory(), true);
  const listed = await run("git", ["worktree", "list", "--porcelain"], { cwd: repo });
  assert.match(listed.stdout, new RegExp(wb.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("1.2 an unwritable dataRoot fails with a named reason, never silently", async () => {
  // dataRoot points at a regular file, so mkdir of <file>/workbenches/… fails.
  const file = path.join(await tmp("wb-file"), "not-a-dir");
  await fs.writeFile(file, "x");
  await assert.rejects(
    () => create({ base: file, run: "r", dataRoot: file, backend: "directory" }),
    (err) => err.code === "WORKBENCH_CREATE_FAILED" && /工作台未建立/.test(err.message)
  );
});

test("1.2 an empty run reference is refused", async () => {
  const dataRoot = await tmp("wb-data");
  await assert.rejects(
    () => create({ base: dataRoot, run: "  ", dataRoot, backend: "directory" }),
    (err) => err.code === "WORKBENCH_CREATE_FAILED" && /non-empty/.test(err.message)
  );
});

// ── 1.3 release ──────────────────────────────────────────────────────────────

test("1.3 keepDays>0 defers deletion (inspection window)", async () => {
  const dataRoot = await tmp("wb-data");
  const wb = await create({ base: dataRoot, run: "keep", dataRoot, backend: "directory" });
  const r = await release({ workbenchRef: wb.workbenchRef, backend: "directory", dataRoot, keepDays: 3 });
  assert.equal(r.deferred, true);
  assert.equal((await fs.stat(wb.cwd)).isDirectory(), true, "deferred release must leave the dir");
});

test("1.3 keepDays=0 removes now and reports it", async () => {
  const dataRoot = await tmp("wb-data");
  const wb = await create({ base: dataRoot, run: "gone", dataRoot, backend: "directory" });
  const r = await release({ workbenchRef: wb.workbenchRef, backend: "directory", dataRoot, keepDays: 0 });
  assert.deepEqual(r.removed, [wb.cwd]);
  await assert.rejects(() => fs.stat(wb.cwd));
});

test("1.3 worktree release removes the git registration too", async () => {
  const repo = await gitRepo();
  const dataRoot = await tmp("wb-data");
  const wb = await create({ base: repo, run: "wt-gone", dataRoot, backend: "worktree" });
  await release({ workbenchRef: wb.workbenchRef, backend: "worktree", dataRoot, keepDays: 0 });
  const listed = await run("git", ["worktree", "list", "--porcelain"], { cwd: repo });
  assert.doesNotMatch(listed.stdout, new RegExp(wb.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("1.5 removing a nonexistent workbench does not throw", async () => {
  const dataRoot = await tmp("wb-data");
  const r = await release({ workbenchRef: "never-existed", backend: "directory", dataRoot, keepDays: 0 });
  assert.deepEqual(r.leftovers, []);
});

// ── 1.4 sweep ────────────────────────────────────────────────────────────────

test("1.4 sweep reaps dead workbenches older than keepDays and keeps live ones", async () => {
  const dataRoot = await tmp("wb-data");
  const dead = await create({ base: dataRoot, run: "dead", dataRoot, backend: "directory" });
  const live = await create({ base: dataRoot, run: "live", dataRoot, backend: "directory" });
  // Age the dead one well past the retention window.
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await fs.utimes(dead.cwd, old, old);

  const r = await sweep({ dataRoot, isLive: (ref) => ref === "live", keepDays: 7 });
  assert.deepEqual(r.removed, [dead.cwd]);
  assert.deepEqual(r.kept, [live.cwd]);
  await assert.rejects(() => fs.stat(dead.cwd));
  assert.equal((await fs.stat(live.cwd)).isDirectory(), true);
});

test("1.4 sweep with keepDays=0 reaps every dead one regardless of age", async () => {
  const dataRoot = await tmp("wb-data");
  const a = await create({ base: dataRoot, run: "a", dataRoot, backend: "directory" });
  const b = await create({ base: dataRoot, run: "b", dataRoot, backend: "directory" });
  const r = await sweep({ dataRoot, isLive: () => false, keepDays: 0 });
  assert.deepEqual(r.removed.sort(), [a.cwd, b.cwd].sort());
});

test("1.4 sweep on a dataRoot with no workbenches/ is a no-op", async () => {
  const dataRoot = await tmp("wb-empty");
  const r = await sweep({ dataRoot, keepDays: 7 });
  assert.deepEqual(r, { removed: [], kept: [], failed: [] });
});

// ── 1.5 usage / quota ────────────────────────────────────────────────────────

test("1.5 usageOf reports bytes, MiB and the over-quota flag", async () => {
  const dataRoot = await tmp("wb-data");
  const wb = await create({ base: dataRoot, run: "u", dataRoot, backend: "directory" });
  await fs.writeFile(path.join(wb.cwd, "a.bin"), Buffer.alloc(1024 * 1024)); // 1 MiB

  const u = await usageOf({ workbenchRef: wb.workbenchRef, dataRoot, limitMb: 10 });
  assert.equal(u.bytes, 1024 * 1024);
  assert.equal(u.mb, 1);
  assert.equal(u.over, false);

  const over = await usageOf({ workbenchRef: wb.workbenchRef, dataRoot, limitMb: 0.5 });
  assert.equal(over.over, true);
});

test("1.5 usage on a missing workbench is zero, not an error", async () => {
  const dataRoot = await tmp("wb-data");
  const u = await usageOf({ workbenchRef: "nope", dataRoot, limitMb: 10 });
  assert.deepEqual({ bytes: u.bytes, over: u.over }, { bytes: 0, over: false });
});

test("1.5 usage counts nested directories", async () => {
  const dataRoot = await tmp("wb-data");
  const wb = await create({ base: dataRoot, run: "n", dataRoot, backend: "directory" });
  await fs.mkdir(path.join(wb.cwd, "deep", "er"), { recursive: true });
  await fs.writeFile(path.join(wb.cwd, "deep", "er", "f"), Buffer.alloc(2048));
  const u = await usageOf({ workbenchRef: wb.workbenchRef, dataRoot, limitMb: 10 });
  assert.equal(u.bytes, 2048);
});
