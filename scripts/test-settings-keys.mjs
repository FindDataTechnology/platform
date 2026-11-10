// Guard test — SETTING_KEYS has exactly ONE definition and every consumer
// reads the shared list (lib/settings-keys.js).
//
// The list drifted THREE ways before this (electron/config/settings.js,
// supervisor/steward-main.js, local-services.js each carried their own copy —
// local-services was missing every desktop key, the steward's copy lacked the
// launcher extras). A second copy appearing anywhere must fail this test.
//
// Run: node --test scripts/test-settings-keys.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { SETTING_KEYS } = await import("../lib/settings-keys.js");

// The consolidation (151b4a93) renamed the shared list to SETTING_KEYS. The
// shipped v1.3.25 desktop died at resident-boot with "ReferenceError:
// SETTINGS_KEYS is not defined" — a consumer kept looping the OLD plural name,
// invisible to typecheck (plain JS) and to the "no second definition" guard
// above (an undefined reference is not a definition). This assertion pins the
// class: every consumer of the single source must reference the shared name
// and must NOT mention the pre-consolidation one.
test("consumers reference the shared name, never the pre-consolidation SETTINGS_KEYS", () => {
  const consumers = [
    "supervisor/steward-main.js",
    "electron/config/settings.js",
    "local-services.js",
  ];
  for (const rel of consumers) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(
      !/\bSETTINGS_KEYS\b/.test(src),
      `${rel} references SETTINGS_KEYS (the removed inline list) — boot crashes with a ReferenceError`,
    );
    assert.ok(
      src.includes("SETTING_KEYS"),
      `${rel} must consume the shared SETTING_KEYS list`,
    );
  }
});

test("the shared list carries the keys each consumer actually needs", () => {
  const required = [
    "LLM_API_KEY",
    "AUTH_MODE",
    "DESKTOP_SERVER_PORT",
    "WANXING_PLUGIN_ENABLED",
    "WANXING_PLUGIN_RUNNER_ID",
    "WANXING_LOCAL_FEED_TOKEN",
    "AGENT_SERVING_REGISTRY_URL",
    "AGENT_SERVING_REGISTRY_TOKEN",
    "AGENT_RUNNER_FLEET_URL",
    "SEARCH_RELAY_URL",
  ];
  for (const key of required) {
    assert.ok(SETTING_KEYS.includes(key), `missing critical key: ${key}`);
  }
  assert.equal(new Set(SETTING_KEYS).size, SETTING_KEYS.length, "no duplicate keys");
});

test("exactly ONE definition exists in the repo (no second copy)", () => {
  // Scan every tracked .js file for a literal list definition.
  const out = execFileSync("git", ["ls-files", "*.js"], { encoding: "utf8", cwd: ROOT });
  const files = out.split("\n").filter(Boolean);
  const offenders = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let text = "";
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // A definition = declaring the array with at least one quoted key inside
    // (the shared module's `export const SETTING_KEYS = [` is the only legal one).
    if (/SETTING_KEYS\s*=\s*\[\s*["']/.test(text) && rel !== path.join("lib", "settings-keys.js")) {
      offenders.push(rel);
    }
    // Consumers must import the shared list, not redefine it.
    if (/SETTING_KEYS/.test(text) && !text.includes("lib/settings-keys.js") && rel !== path.join("lib", "settings-keys.js") && rel !== path.join("scripts", "test-settings-keys.mjs")) {
      offenders.push(`${rel} (uses SETTING_KEYS without importing the shared list)`);
    }
  }
  assert.deepEqual(offenders, [], "SETTING_KEYS must have exactly one definition and shared imports");
});

test("the three consumers import the shared list", () => {
  for (const rel of [
    "electron/config/settings.js",
    "supervisor/steward-main.js",
    "local-services.js",
  ]) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(
      text,
      /import\s*\{\s*SETTING_KEYS\s*\}\s*from\s*"[^"]*lib\/settings-keys\.js"/,
      `${rel} must import lib/settings-keys.js`,
    );
  }
});
