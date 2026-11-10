#!/usr/bin/env node
// first-run bootstrap contract tests (optimize-paas-module-audit N-18).
//
// openspec/specs/first-run-bootstrap has five Requirement blocks (idempotent
// seeding, merge-not-replace, failure-never-blocks-launch) but the module had
// no dedicated test file — the only coverage was one seat-id assertion inside
// test-desktop-fleet-runner.mjs. These drive the real filesystem: temp+rename
// atomicity, id stability, merge direction, and both failure modes the spec
// promises to swallow.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runFirstRun } from "../bootstrap/first-run.js";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-"));
  t.after(() => {
    // A test may have locked the directory down to simulate an unwritable
    // userData; restore the mode so the cleanup can actually remove it.
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Capture the module's console output without letting it into the test log.
function captureConsole(t) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  t.after(() => {
    console.log = origLog;
    console.error = origErr;
  });
  return { logs, errs };
}

function settingsPathIn(dir, name = "settings.json") {
  return path.join(dir, name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function leftovers(dir) {
  // atomicWrite uses a sibling temp file; a completed write must leave none.
  return fs.readdirSync(dir).filter((n) => n !== "settings.json");
}

test("fresh install seeds the settings file atomically and returns the same document", (t) => {
  const dir = tmpDir(t);
  const out = runFirstRun({ userDataDir: dir, defaultSettings: { DEFAULT_MODEL: "seeded" } });

  assert.equal(out.DEFAULT_MODEL, "seeded");
  assert.match(out.WANXING_PLUGIN_RUNNER_ID, /^desktop-[0-9a-f]{8}$/, "seat id minted");
  assert.match(out.WANXING_LOCAL_FEED_TOKEN, /^[0-9a-f]{48}$/, "feed token is 24 random bytes");
  assert.deepEqual(readJson(settingsPathIn(dir)), out, "disk matches the returned document");
  assert.deepEqual(leftovers(dir), [], "no temp file left behind");
});

test("second launch does not rewrite a complete file and keeps the minted ids", (t) => {
  const dir = tmpDir(t);
  const first = runFirstRun({ userDataDir: dir, defaultSettings: { DEFAULT_MODEL: "seeded" } });
  const before = fs.readFileSync(settingsPathIn(dir), "utf8");

  const second = runFirstRun({ userDataDir: dir, defaultSettings: { DEFAULT_MODEL: "seeded" } });

  // The whole point of minting in bootstrap: the runner id and feed token are
  // stable across launches, so env injection never diverges from the cell's
  // verifier (the reason both are minted here rather than per-start).
  assert.equal(second.WANXING_PLUGIN_RUNNER_ID, first.WANXING_PLUGIN_RUNNER_ID);
  assert.equal(second.WANXING_LOCAL_FEED_TOKEN, first.WANXING_LOCAL_FEED_TOKEN);
  assert.equal(fs.readFileSync(settingsPathIn(dir), "utf8"), before, "file untouched");
});

test("merge fills a missing seeded key and keeps user-set values", (t) => {
  const dir = tmpDir(t);
  const file = settingsPathIn(dir);
  fs.writeFileSync(file, JSON.stringify({ DEFAULT_MODEL: "user-choice", CUSTOM: 1 }));

  const out = runFirstRun({ userDataDir: dir, defaultSettings: { DEFAULT_MODEL: "seeded", LLM_BASE_URL: "http://x" } });

  assert.equal(out.DEFAULT_MODEL, "user-choice", "user value wins over the seed");
  assert.equal(out.LLM_BASE_URL, "http://x", "missing seeded key is filled in");
  assert.equal(out.CUSTOM, 1, "unknown user keys survive the merge");
  const onDisk = readJson(file);
  assert.deepEqual(onDisk, out);
  assert.deepEqual(leftovers(dir), []);
});

test("a custom settings file name is honoured (the headless launcher's dev-settings.json)", (t) => {
  const dir = tmpDir(t);
  runFirstRun({ userDataDir: dir, defaultSettings: {}, settingsFileName: "dev-settings.json" });

  assert.ok(fs.existsSync(settingsPathIn(dir, "dev-settings.json")));
  assert.ok(!fs.existsSync(settingsPathIn(dir, "settings.json")), "does not seed the default name");
});

test("corrupt settings file: logged, file untouched, no throw", (t) => {
  const { errs } = captureConsole(t);
  const dir = tmpDir(t);
  const file = settingsPathIn(dir);
  fs.writeFileSync(file, "{ this is not json");
  const before = fs.readFileSync(file, "utf8");

  const out = runFirstRun({ userDataDir: dir, defaultSettings: { DEFAULT_MODEL: "seeded" } });

  assert.equal(fs.readFileSync(file, "utf8"), before, "corrupt file is left byte-identical");
  assert.equal(out.DEFAULT_MODEL, "seeded", "returns the defaults so the caller still boots");
  assert.ok(errs.some((l) => l.includes("Corrupt settings file")), "logged as an error");
});

test("unwritable settings file: logged, no throw (bootstrap must not block launch)", (t) => {
  const { errs } = captureConsole(t);
  const dir = tmpDir(t);
  // Read-only directory: mkdir succeeds (it exists), the temp+rename cannot.
  // tmpDir's teardown restores the mode before removing the tree.
  fs.chmodSync(dir, 0o500);

  let out;
  assert.doesNotThrow(() => {
    out = runFirstRun({ userDataDir: dir, defaultSettings: { DEFAULT_MODEL: "seeded" } });
  }, "spec: a failed write SHALL NOT throw at the caller");

  assert.equal(out.DEFAULT_MODEL, "seeded");
  assert.ok(
    errs.some((l) => l.includes("[bootstrap]")),
    "the failure is logged instead of thrown",
  );
});
