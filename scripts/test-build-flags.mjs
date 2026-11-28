// Build facts travel with the artifact (harden-desktop-release-lane 3.2):
// "signed" must come from the packed app, not from a runtime env switch.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBuildFlags, resolveSigned, buildFlagsFromEnv } from "../electron/build-flags.js";

test("no flag file (dev run / older build) degrades to unsigned", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flags-"));
  assert.deepEqual(readBuildFlags(dir), { signed: false, notarized: false });
});

test("malformed flag file is unsigned, never signed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flags-"));
  writeFileSync(path.join(dir, "build-flags.json"), "{not json");
  assert.equal(readBuildFlags(dir).signed, false);
});

test("a signed flag is honoured on non-mac platforms without a bundle check", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flags-"));
  writeFileSync(path.join(dir, "build-flags.json"), JSON.stringify({ signed: true }));
  assert.equal(resolveSigned({ resourcesPath: dir, platform: "win32" }), true);
});

test("on macOS a signed flag is verified against the bundle — a lie degrades", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flags-"));
  writeFileSync(path.join(dir, "build-flags.json"), JSON.stringify({ signed: true }));
  assert.equal(resolveSigned({ resourcesPath: dir, platform: "darwin", bundlePath: "/Applications/Platform.app", verify: () => false }), false);
  assert.equal(resolveSigned({ resourcesPath: dir, platform: "darwin", bundlePath: "/Applications/Platform.app", verify: () => true }), true);
});

test("unsigned flag stays unsigned even when a bundle would verify", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flags-"));
  writeFileSync(path.join(dir, "build-flags.json"), JSON.stringify({ signed: false }));
  assert.equal(resolveSigned({ resourcesPath: dir, platform: "darwin", bundlePath: "/x", verify: () => true }), false);
});

test("afterPack facts follow the same env the signer reads", () => {
  assert.deepEqual(buildFlagsFromEnv({}, "darwin").signed, false);
  assert.deepEqual(buildFlagsFromEnv({ CSC_LINK: "x" }, "darwin").signed, true);
  assert.deepEqual(buildFlagsFromEnv({ WIN_CSC_LINK: "x" }, "win32").signed, true);
  assert.deepEqual(buildFlagsFromEnv({ CSC_LINK: "" }, "darwin").signed, false);
  const notarized = buildFlagsFromEnv({ CSC_LINK: "x", APPLE_ID: "a", APPLE_APP_SPECIFIC_PASSWORD: "b", APPLE_TEAM_ID: "c" }, "darwin");
  assert.equal(notarized.notarized, true);
});

test("nothing in the runtime still reads DESKTOP_SIGNED", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../electron/main.js", import.meta.url), "utf8");
  assert.ok(!/process\.env\.DESKTOP_SIGNED/.test(main), "the never-set env switch must not come back");
});
