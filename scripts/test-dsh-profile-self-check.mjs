// `node dsh-profile.js` is a shipped guard: it builds the llm section, the MCP
// / skills / presets / permissions patches and the pack-scope derivation, then
// checks the invariants it just produced. Two defects made that guard
// worthless, and both are asserted here:
//
//   1. It could not run at all. dsh-profile.js carries a top-level await, so it
//      is an ASYNC module; llm-providers.js imported RETRY_POLICY from it
//      statically, and `buildLlmProfile()` imports llm-providers.js lazily.
//      When dsh-profile.js is the entry point, that lazy edge is taken while
//      the entry is still evaluating-async, so the spec makes llm-providers'
//      evaluation wait for it — which waits for llm-providers. Deadlock: only
//      the dotenv banner printed, exit code 13 ("Detected unsettled top-level
//      await"). Measured on HEAD (2971) and on the working tree (3165).
//   2. Even when it ran, every invariant was a `console.assert`, which logs and
//      leaves exit code 0 — a guard that cannot go red.
//
// This test spawns the real entry point (the only way to exercise the
// entry-point cycle) in an isolated $DSH_HOME, and requires a clean exit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function runSelfCheck() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-selfcheck-test-"));
  const dshHome = path.join(home, "dsh");
  const sharedHome = path.join(home, "shared");
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(sharedHome, { recursive: true });
  const res = spawnSync(process.execPath, ["dsh-profile.js"], {
    cwd: root,
    encoding: "utf8",
    // Isolate the run: the self-check writes real patch files, and a test must
    // never touch the developer's or the deployment's actual profile.
    // LLM_API_KEY is FORCED (a dummy): without it the volces route is dormant,
    // the thinking-level assertions are skipped, and this test would pass while
    // checking nothing — the empty-run trap the assertions exist to avoid.
    env: {
      ...process.env,
      LLM_API_KEY: "self-check-dummy-key",
      DSH_HOME: dshHome,
      DSH_SHARED_HOME: sharedHome,
      DB_PATH: path.join(home, "app.db"),
    },
    timeout: 120000,
  });
  return { ...res, home, dshHome };
}

test("the module self-check runs to completion and exits 0", () => {
  const { status, stdout, stderr, dshHome } = runSelfCheck();
  // The deadlock left `status === 13` and no output past the dotenv banner.
  assert.equal(status, 0, `self-check must exit 0 (stderr tail: ${(stderr || "").slice(-400)})`);

  // Every section must have produced its own OK line — a partial run is a fail
  // even with exit 0 (an early `return` inside the block would look healthy).
  for (const marker of [
    "OK reasoning effort round-trips",
    "OK catalog agent preset composes",
    "OK deriveScope: shipped=full, pack preset=focused",
    "OK deriveScope: uninstalled pack self-heals to full",
    "OK mcp patch:",
    "OK skills patch:",
    "OK catalog persona focus note",
  ]) {
    assert.ok(stdout.includes(marker), `self-check output is missing "${marker}"`);
  }
  assert.equal(/self-check FAILED/.test(stdout + stderr), false, "no invariant may be violated");

  // Isolation proof: the patches landed in the throwaway home, not the real one.
  const patch = path.join(dshHome, "profiles", "platform", "mcp.patch.yml");
  assert.ok(fs.existsSync(patch), "the run must write its patches into $DSH_HOME (isolation)");
  fs.rmSync(path.dirname(dshHome), { recursive: true, force: true });
});

test("the self-check's own artifacts do not survive in $DSH_HOME", () => {
  const { status, dshHome } = runSelfCheck();
  assert.equal(status, 0);
  const defsPath = path.join(dshHome, ".agent-presets.defs.json");
  const defs = fs.existsSync(defsPath) ? JSON.parse(fs.readFileSync(defsPath, "utf8")) : [];
  assert.equal(
    defs.some((d) => d?.entryId === "scope-selfcheck-agent"),
    false,
    "the self-check agent must not be left behind in the preset defs",
  );
  const presets = path.join(dshHome, "profiles", "platform", "presets.patch.yml");
  const text = fs.existsSync(presets) ? fs.readFileSync(presets, "utf8") : "";
  assert.equal(
    text.includes("preset-scope-selfcheck-agent"),
    false,
    "the preset overlay must be rewritten after the cleanup, not left holding a dead agent row",
  );
  fs.rmSync(path.dirname(dshHome), { recursive: true, force: true });
});
