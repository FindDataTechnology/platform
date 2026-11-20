#!/usr/bin/env node
// Cross-PROCESS kill proof for the claim lane (harden-agent-runtime-spine, 7.1).
//
// The unit suites prove the rules and the store, but they all run inside ONE
// process — and the failure this capability exists to fix is precisely "the
// process died". A same-process test can simulate it with an injected clock;
// only a real child that is really killed proves the claim outlives it.
//
// What this does, and why each step cannot be faked:
//   1. spawn a CHILD node process that opens a claim and then blocks forever
//   2. wait until the claim is readable ON DISK from THIS process (a different
//      process, a different connection) — not merely "the call returned"
//   3. SIGKILL the child (no cleanup, no finally, no graceful close)
//   4. run the sweeper past the lease in THIS process
//   5. assert the attempt closed as `lease_expired` and is NOT a failure
//   6. assert a heartbeat can no longer revive it
//
// Runs on any Node ≥20, including Windows (spawn + SIGKILL via taskkill). No
// network, no Postgres, no platform dependencies.
//
//   node --test scripts/test-claim-cross-process-kill.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const { createTurnClaimStore } = await import("../lib/turn-claim-store.js");
const { LEASE_MS, countsAsFailure, turnRefFor } = await import("../lib/turn-claim.js");

const REF = turnRefFor({ driver: "platform", source: "cell:0123456789abcdef", runId: "run_kill", turnId: "turn_kill" });

const { pathToFileURL } = await import("node:url");
const asUrl = (p) => pathToFileURL(p).href;

/** The child: open the claim, print READY, then block until killed. */
function childSource(dbFile) {
  return `
import Database from ${JSON.stringify(asUrl(path.join(ROOT, "node_modules", "better-sqlite3", "lib", "index.js")))};
import { createTurnClaimStore } from ${JSON.stringify(asUrl(path.join(ROOT, "lib", "turn-claim-store.js")))};

const db = new Database(${JSON.stringify(dbFile)});
db.pragma("journal_mode = WAL");
const store = createTurnClaimStore({ db, now: () => 1_000_000 });
const out = store.claim({
  turnRef: ${JSON.stringify(REF)},
  driver: "platform",
  source: "cell:0123456789abcdef",
  runId: "run_kill",
  turnId: "turn_kill",
  startedAt: 1_000_000,
});
if (!out.ok) { console.error("claim failed", out); process.exit(2); }
console.log("READY");
// Stay alive so the parent has a live process to kill. A real tenant turn would
// be awaiting a model here; the point is that nothing will close the claim.
setInterval(() => {}, 1000);
`;
}

/** Kill the child hard, cross-platform. */
function hardKill(child) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch { /* already gone */ }
  } else {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Remove a temp dir, tolerating Windows' deferred handle release.
 *
 * On Windows a SQLite connection holds the file until it is CLOSED, and even
 * then the OS may take a moment. Retrying is the fix; a hard failure on
 * cleanup would turn a passing behavioural assertion into a red test that says
 * nothing about the code (measured on windows-admin, 2026-11-20).
 */
function removeDirEventually(dir, { attempts = 20, stepMs = 100 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs);
    }
  }
}

const waitFor = (fn, { timeoutMs = 20_000, stepMs = 100 } = {}) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting"));
      setTimeout(tick, stepMs);
    };
    tick();
  });

test("a claim outlives SIGKILL, and the sweeper closes it as lease_expired (not failed)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claim-kill-"));
  const dbFile = path.join(dir, "fleets.db");
  const srcFile = path.join(dir, "child.mjs");
  writeFileSync(srcFile, childSource(dbFile), "utf8");

  let reader = null;
  const child = spawn(process.execPath, [srcFile], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });

  try {
    // 1–2: wait until the CHILD says it wrote the claim, then confirm THIS
    // process can read it on disk. Reading it from here is the whole point —
    // same-process memory would prove nothing.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`child never reported READY; stderr=${stderr}`)), 20_000);
      child.stdout.on("data", (d) => {
        if (String(d).includes("READY")) { clearTimeout(t); resolve(); }
      });
      child.on("exit", (code) => reject(new Error(`child exited early (${code}); stderr=${stderr}`)));
    });

    reader = new Database(dbFile, { readonly: false });
    const rowsBefore = reader.prepare("SELECT * FROM turn_claims WHERE turn_ref = ?").all(REF);
    assert.equal(rowsBefore.length, 1, "the claim is on disk while the owner process is still alive");
    assert.equal(rowsBefore[0].closed_at, null);

    // 3: kill it. No finally runs, no close() — exactly the pod-roll shape.
    hardKill(child);
    await new Promise((r) => child.on("exit", r).setTimeout?.(5_000) ?? setTimeout(r, 500));

    // The row is STILL there after the owner is gone.
    const rowsAfter = reader.prepare("SELECT * FROM turn_claims WHERE turn_ref = ?").all(REF);
    assert.equal(rowsAfter.length, 1, "killing the process does not remove the attempt");
    assert.equal(rowsAfter[0].closed_at, null, "nothing closed it — the owner died first");

    // 4: a NEW store (a restarted process) sweeps past the lease.
    const sweepStore = createTurnClaimStore({ db: reader, now: () => 1_000_000 + LEASE_MS + 5 });
    const closed = sweepStore.sweep({ nowMs: 1_000_000 + LEASE_MS + 5 });
    assert.equal(closed.length, 1, "the sweeper finds the orphan and closes it");
    assert.equal(closed[0].close_reason, "lease_expired");

    // 5: it is NOT a failure — the whole point of the vocabulary split.
    assert.equal(countsAsFailure(closed[0].close_reason), false, "a lapsed attempt must not sit in a failure rate");

    // 6: a late heartbeat cannot revive it.
    const revive = sweepStore.heartbeat(REF, { nowMs: 1_000_000 + LEASE_MS + 60_000 });
    assert.equal(revive.ok, false, "a closed claim cannot be beaten back to life");
    assert.equal(sweepStore.get(REF).close_reason, "lease_expired", "the terminal state stands");
  } finally {
    hardKill(child);
    try { child.kill(); } catch { /* gone */ }
    try { reader.close(); } catch { /* already closed */ }
    removeDirEventually(dir);
  }
});

test("the closed claim names WHEN it was last alive (the fact a reader needs)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claim-kill2-"));
  const dbFile = path.join(dir, "fleets.db");
  const srcFile = path.join(dir, "child.mjs");
  writeFileSync(srcFile, childSource(dbFile), "utf8");

  const child = spawn(process.execPath, [srcFile], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("child never reported READY")), 20_000);
      child.stdout.on("data", (d) => { if (String(d).includes("READY")) { clearTimeout(t); resolve(); } });
      child.on("exit", (code) => reject(new Error(`child exited early (${code})`)));
    });
    hardKill(child);
    await new Promise((r) => setTimeout(r, 500));

    const db = new Database(dbFile);
    const events = [];
    const store = createTurnClaimStore({ db, now: () => 1_000_000 + LEASE_MS + 5, emit: (e) => events.push(e) });
    store.sweep({ nowMs: 1_000_000 + LEASE_MS + 5 });
    const ev = events.find((e) => e.kind === "lease.expired");
    assert.ok(ev, "expiry is an EVENT, not an inference");
    assert.equal(ev.last_heartbeat_at, 1_000_000, "the event says when it was last alive");
    assert.equal(ev.held_ms, LEASE_MS + 5, "and for how long it was held");
    db.close();
  } finally {
    hardKill(child);
    try { child.kill(); } catch { /* gone */ }
    removeDirEventually(dir);
  }
});
