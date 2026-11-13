// Unit tests — the fleet plugin read face (change add-fleet-plugin-
// declaration, tasks 3.1 / 3.2).
// Run: node --test scripts/test-fleet-plugins-readface.mjs
//
// The read face is derived, never stored: these cases change the patch on disk
// and assert the very next read reflects it (3.1), and they inject a plugin the
// roster does not carry to prove it is NOT shown as effective (3.2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { writeFleetPluginRows, readFleetPluginRows } from "../dsh-profile.js";
import { composeFleetPluginView } from "../server/fleet-plugins.js";

const tmp = mkdtempSync(path.join(tmpdir(), "fleet-plugin-readface-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function home() {
  const dir = path.join(tmp, `home-${++seq}`);
  const profileDir = path.join(dir, "profiles", "platform");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, "cordis.patch.yml"),
    yaml.dump([{ insert: [{ id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server" }] }]),
  );
  return dir;
}

const dirs = (dir) => ({ dshHome: dir, profileName: "platform" });

function land(dir, rows) {
  writeFleetPluginRows({ dirs: dirs(dir), rows });
}

test("a team-declared plugin appears as source 'team' with its sharers", () => {
  const dir = home();
  land(dir, [{ id: "pdf-kit", name: "pdf-kit", fleets: ["f1", "f2"] }]);
  const plugins = composeFleetPluginView({
    fleetId: "f1",
    declaredPlugins: [{ id: "pdf-kit" }],
    effective: readFleetPluginRows(dirs(dir)),
  });
  assert.deepEqual(plugins, [{ id: "pdf-kit", name: "pdf-kit", sharedWith: ["f2"], source: "team" }]);
});

test("a deployment-enabled bundle the team never declared shows as 'deployment'", () => {
  const dir = home();
  land(dir, [{ id: "pdf-kit", name: "pdf-kit", fleets: ["f1"] }]);
  const plugins = composeFleetPluginView({
    fleetId: "f1",
    declaredPlugins: [{ id: "pdf-kit" }],
    effective: readFleetPluginRows(dirs(dir)),
    roster: [
      { id: "pdf-kit", enabled: true }, // declared → team, not deployment
      { id: "shared-web-search", enabled: true }, // default-on for everyone
      { id: "optional-kit", enabled: false }, // present but off → not effective
    ],
  });
  assert.deepEqual(plugins.map((p) => `${p.id}:${p.source}`), ["pdf-kit:team", "shared-web-search:deployment"]);
});

test("the read face is live: a patch change is visible on the next read", () => {
  const dir = home();
  land(dir, [{ id: "pdf-kit", name: "pdf-kit", fleets: ["f1"] }]);
  const declaredPlugins = [{ id: "pdf-kit" }];
  const view = () => composeFleetPluginView({ fleetId: "f1", declaredPlugins, effective: readFleetPluginRows(dirs(dir)) });
  assert.equal(view().length, 1);

  land(dir, [{ id: "legal-kit", name: "legal-kit", fleets: ["f1"] }]);
  const after = view();
  // The fleet still declares pdf-kit, but the profile no longer composes it —
  // a declaration is not an effect, and the read face must not pretend.
  assert.deepEqual(after, []);
});

test("a declared plugin the roster does not carry is never shown as effective", () => {
  const dir = home();
  land(dir, []); // nothing landed
  const plugins = composeFleetPluginView({ fleetId: "f1", declaredPlugins: [{ id: "ghost" }], effective: readFleetPluginRows(dirs(dir)) });
  assert.deepEqual(plugins, []);
});

test("a hand-edited patch row nobody declared is not reported", () => {
  const dir = home();
  land(dir, [{ id: "pdf-kit", name: "pdf-kit", fleets: ["f1"] }]);
  // Someone appends a row by hand (no ledger entry).
  const patchPath = path.join(dir, "profiles", "platform", "cordis.patch.yml");
  const doc = yaml.load(readFileSync(patchPath, "utf8"));
  doc[0].insert.push({ id: "hand-edited", name: "hand-edited" });
  writeFileSync(patchPath, yaml.dump(doc));

  const plugins = composeFleetPluginView({ fleetId: "f1", declaredPlugins: [{ id: "hand-edited" }], effective: readFleetPluginRows(dirs(dir)) });
  assert.deepEqual(plugins, [], "the ledger is the authority on what a team plugin is");
});
