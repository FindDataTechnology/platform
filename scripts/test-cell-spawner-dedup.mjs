#!/usr/bin/env node
// ── Cell spawner one-process-per-user test (fix-cell-spawn-inflight-dedup) ────
//
// Reproduces the 2026-10-10 defect: two requests arriving inside a cell's
// startup window each spawned their own cell process, and the first was
// orphaned (running, unrouted, unreapable, still holding the data root).
//
//   node --test scripts/test-cell-spawner-dedup.mjs
//
// The stub cell accepts a START_DELAY_MS env knob so the test can hold the
// startup window open deterministically instead of racing the real server.js.

import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCellRegistry, userIdFor } from "../gateway/spawner.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A cell stub that binds PORT (so waitForPort resolves) after an optional
// delay, and exits on SIGTERM. PID is echoed so the test can tell two spawns
// apart; START_DELAY_MS widens the window the spawner must collapse.
const STUB = `
import http from "node:http";
const delay = Number(process.env.START_DELAY_MS || 0);
const port = Number(process.env.PORT || 0);
setTimeout(() => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ pid: process.pid, port }));
  });
  server.listen(port, "127.0.0.1");
}, delay);
process.on("SIGTERM", () => process.exit(0));
`;

async function makeRegistry(overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "spawner-dedup-")));
  const stub = path.join(root, "stub-cell.mjs");
  await writeFile(stub, STUB);
  const registry = createCellRegistry({
    dataRoot: path.join(root, "cells"),
    secret: "test-secret",
    startTimeoutMs: 15_000,
    idleReapSecs: 0,
    serverEntry: stub,
    env: { ...process.env, START_DELAY_MS: "600" },
    ...overrides,
  });
  return { root, registry };
}

// Count live cell processes for a user by asking the registry, plus a direct
// /proc-free check: the records we hold are the gateway's view, so the test
// also asserts the registry agrees with itself (status length).
function liveFor(registry, email) {
  const id = userIdFor(email);
  return registry.status().filter((c) => c.userId === id);
}

test("concurrent first requests collapse onto exactly one spawn", async () => {
  const { root, registry } = await makeRegistry();
  const email = "alice@spawner-dedup.test";
  try {
    // Fire both inside the stub's startup window.
    const [a, b] = await Promise.all([
      registry.ensure({ email, groups: [] }),
      registry.ensure({ email, groups: [] }),
    ]);
    assert.equal(a.pid, b.pid, "both requests must be served by the same cell process");
    const live = liveFor(registry, email);
    assert.equal(live.length, 1, `exactly one record expected, got ${live.length}`);
    assert.equal(live[0].state, "running");

    // And exactly one spawned process: count dumps is not possible (no file),
    // so assert via the record count plus that the second call did not bump a
    // second pid.
    assert.ok(a.pid > 0, "cell pid recorded");
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a second ensure during startup does not create a second process", async () => {
  const { root, registry } = await makeRegistry();
  const email = "bob@spawner-dedup.test";
  try {
    const first = registry.ensure({ email, groups: [] });
    // Same tick, before the stub has listened: the classic race window.
    const second = registry.ensure({ email, groups: [] });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.pid, b.pid);
    assert.equal(liveFor(registry, email).length, 1);
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop terminates the process and its record disappears", async () => {
  const { root, registry } = await makeRegistry();
  const email = "carol@spawner-dedup.test";
  try {
    const cell = await registry.ensure({ email, groups: [] });
    assert.equal(liveFor(registry, email).length, 1);
    const stopped = registry.stop(userIdFor(email), "test");
    assert.equal(stopped, true, "stop reports it found the cell");
    // The exit handler removes the record once the process is really gone.
    for (let i = 0; i < 60 && liveFor(registry, email).length > 0; i++) await sleep(100);
    assert.equal(liveFor(registry, email).length, 0, "record removed after the process exits");
    assert.notEqual(cell.pid, undefined);
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("replacing a record terminates the previous live process", async () => {
  const { root, registry } = await makeRegistry();
  const email = "dave@spawner-dedup.test";
  try {
    const first = await registry.ensure({ email, groups: [] });
    const firstPid = first.pid;
    // Simulate the "record gone but process alive" shape by dropping the
    // record while the process runs, then ensuring again: the spawner must
    // terminate the old process rather than leave it orphaned.
    const record = registry.cells.get(userIdFor(email));
    assert.ok(record, "record present before drop");
    // drop() with a live process routes through stop(); its record goes away
    // only after the process exits, so wait for that, then re-ensure.
    registry.drop(userIdFor(email));
    for (let i = 0; i < 60 && registry.cells.get(userIdFor(email)); i++) await sleep(100);
    const second = await registry.ensure({ email, groups: [] });
    assert.notEqual(second.pid, firstPid, "a fresh process was spawned");
    assert.equal(liveFor(registry, email).length, 1, "still exactly one record");
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a cell that never listens fails ensure and leaves no stale record", async () => {
  // START_DELAY_MS beyond startTimeoutMs: the stub never binds in time.
  const { root, registry } = await makeRegistry({ startTimeoutMs: 1200 });
  const email = "erin@spawner-dedup.test";
  try {
    await writeFile(
      path.join(root, "stub-cell.mjs"),
      `process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 60_000);`,
    );
    await assert.rejects(() => registry.ensure({ email, groups: [] }), /did not listen|exited during startup/);
    // The failed attempt must not leave a "starting" record behind: a retry
    // must be able to spawn, and the dead process must not be counted.
    assert.equal(liveFor(registry, email).length, 0, "no stale record after a failed start");
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("two users get two independent cells", async () => {
  const { root, registry } = await makeRegistry();
  try {
    const a = await registry.ensure({ email: "u1@spawner-dedup.test", groups: [] });
    const b = await registry.ensure({ email: "u2@spawner-dedup.test", groups: [] });
    assert.notEqual(a.pid, b.pid);
    assert.equal(registry.status().length, 2, "status reports both cells");
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("per-user data roots are created and separated", async () => {
  const { root, registry } = await makeRegistry();
  try {
    const email = "frank@spawner-dedup.test";
    await registry.ensure({ email, groups: [] });
    const dirs = await readdir(path.join(root, "cells"));
    assert.ok(dirs.includes(userIdFor(email)), "the user's root exists");
    assert.equal(dirs.length, 1, "no extra roots for one user");
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
