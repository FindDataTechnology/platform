// Unit tests — the connector overlay writer (add-served-agent-connector-access D2).
// Run: node --test scripts/test-connector-patch.mjs
//
// A cordis patch overlay can only disable + insert, never rewrite an inserted
// row's plugin name. That is why the face is a chain: questions → matters →
// connector, each layer subclassing the one before. This test pins the two
// facts a wrong chain would break silently:
//
//   1.x  connector.patch.yml disables the MATTERS row (not the questions row)
//        and inserts the connector row — disable the wrong one and the child
//        boots with two live servers, or with the matter trio gone.
//   2.x  every file the chain needs is written, because a child whose overlay
//        imports a missing parent dies at startup with a module-resolution
//        error that reads like a packaging problem, not a writing-order one.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "connector-patch-"));
process.env.DSH_HOME = home;
test.after(() => rmSync(home, { recursive: true, force: true }));

const {
  writeConnectorPatch,
  writeMattersPatch,
  CONNECTOR_PATCH_FILE,
  CONNECTOR_BRIDGE_FILE,
  CONNECTOR_MODULE_FILE,
} = await import("../dsh-profile.js");

const dirs = { dshHome: home, profileName: "platform" };

test("1.1 the patch disables the matters row and inserts the connector row", () => {
  const patchPath = writeConnectorPatch({ dirs });
  assert.equal(path.basename(patchPath), CONNECTOR_PATCH_FILE);
  const patch = readFileSync(patchPath, "utf8");
  assert.match(patch, /id:\s*platform-matters-server/);
  assert.match(patch, /disabled:\s*true/);
  assert.match(patch, /id:\s*platform-connector-server/);
  assert.match(patch, /\.\/platform-connector-bridge\.js/);
  // The questions row is two layers down; disabling it here would silence the
  // ask bridge for a facade child.
  assert.doesNotMatch(patch, /platform-serving-questions-server/);
});

test("2.1 every file the chain imports is written", () => {
  const patchPath = writeConnectorPatch({ dirs });
  const profileDir = path.dirname(patchPath);
  for (const file of [
    CONNECTOR_BRIDGE_FILE,
    CONNECTOR_MODULE_FILE,
    "platform-matters-bridge.js",
    "matter-tools.js",
    "platform-serving-questions-bridge.js",
    "platform-notify-bridge.js",
    "bot-notify.js",
  ]) {
    assert.ok(existsSync(path.join(profileDir, file)), `missing ${file} — the child would fail to resolve its parent`);
  }
});

test("2.2 writing matters first, then connector, leaves a coherent chain", () => {
  // compose.js writes matters then connector for every facade child; the
  // writer must be idempotent in that order (it re-writes the whole parent
  // chain each time).
  writeMattersPatch({ dirs });
  const patchPath = writeConnectorPatch({ dirs });
  const patch = readFileSync(patchPath, "utf8");
  assert.match(patch, /platform-matters-server/);
  assert.match(patch, /platform-connector-server/);
});

test("2.3 the bridge subclasses the matters server and routes the result op", () => {
  const patchPath = writeConnectorPatch({ dirs });
  const source = readFileSync(path.join(path.dirname(patchPath), CONNECTOR_BRIDGE_FILE), "utf8");
  assert.match(source, /extends MattersSdkServer/);
  assert.match(source, /connectorCall\/result/);
  assert.match(source, /createConnectorTools/);
});

test("2.4 the tools module cannot build a connector request of its own", () => {
  // The child must not be able to reach the connector directly: no header
  // construction, no credential, no origin. (The word "authorization" appears
  // in the model-facing prose on purpose — assert on the machinery instead.)
  const patchPath = writeConnectorPatch({ dirs });
  const source = readFileSync(path.join(path.dirname(patchPath), CONNECTOR_MODULE_FILE), "utf8");
  assert.doesNotMatch(source, /Bearer\s/);
  assert.doesNotMatch(source, /headers\s*:/);
  assert.doesNotMatch(source, /x-oo-connector-actor-sub/);
  assert.doesNotMatch(source, /registryToken/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.doesNotMatch(source, /connector\.example|https?:\/\//);
});
