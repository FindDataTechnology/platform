#!/usr/bin/env node
// ── facet credential self-check (add-caller-key-provisioning 2.1/2.2) ────────
//
// The install path must tell a customer which of the TWO keys they are missing,
// without merging the two domains (wgk- = tool surface, sk- = model billing).
// This runs the real CLI's self-test (offline, fake FACET_HOME) and asserts it
// exits 0 — i.e. all three states (both / missing model / missing tool) and the
// three guidance strings hold.
//
//   node --test scripts/test-facet-credential-selfcheck.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = path.resolve("facet/cli/facet.js");

test("self-test: all three credential states assert green, offline", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "facet-cred-test-"));
  try {
    const { stdout } = await exec(process.execPath, [CLI, "self-test"], {
      env: { ...process.env, FACET_HOME: home, FACET_CREDENTIALS_PATH: path.join(home, ".facet", "credentials.json") },
      timeout: 20_000,
    });
    assert.match(stdout, /自检通过（6 项/);
    assert.match(stdout, /✓ 两把都有/);
    assert.match(stdout, /✓ 缺模型键/);
    assert.match(stdout, /✓ 缺工具键/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("self-test: guidance names the two domains separately", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "facet-cred-test-"));
  try {
    const { stdout } = await exec(process.execPath, [CLI, "--self-test"], {
      env: { ...process.env, FACET_HOME: home, FACET_CREDENTIALS_PATH: path.join(home, ".facet", "credentials.json") },
      timeout: 20_000,
    });
    // the two domains must not be collapsed into one "key" story
    assert.ok(/sk-/.test(stdout), "model key (sk-) named");
    assert.ok(/wgk-/.test(stdout), "tool key (wgk-) named");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
