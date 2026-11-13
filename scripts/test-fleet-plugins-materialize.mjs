// Unit tests — team plugin materialization (change add-fleet-plugin-
// declaration, tasks 2.1–2.5).
// Run: node --test scripts/test-fleet-plugins-materialize.mjs
//
// The materialization is a RECOMPUTE, so the tests are about what the profile
// looks like AFTER a landing, not about "did the call happen":
//   · rows carry id + name and nothing else (the loader's own shape);
//   · landing twice is a no-op byte-for-byte (2.2);
//   · a team dropping a plugin removes exactly that row (2.3);
//   · a plugin two teams share survives the first archive and goes with the
//     second (2.4);
//   · the platform's own rows (llm route, insert scaffold) are untouched;
//   · nothing opens a socket (2.5, offline landing).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import yaml from "js-yaml";
import { computeFleetPluginPlan, rowsToRemove, ledgerFromPlan, effectiveRows } from "../lib/fleet-plugin-rows.js";
import { writeFleetPluginRows, readFleetPluginRows, writeLlmProfile } from "../dsh-profile.js";
import { materializeFleetPlugins, declaredPluginsForFleet, fleetPluginView } from "../server/fleet-plugins.js";

const tmp = mkdtempSync(path.join(tmpdir(), "fleet-plugins-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
/** A throwaway DSH_HOME with the scaffold's patch already in it. */
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

function patchRows(dir) {
  const doc = yaml.load(readFileSync(path.join(dir, "profiles", "platform", "cordis.patch.yml"), "utf8"));
  return doc.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : [entry]));
}

function land(dir, fleets) {
  const plan = computeFleetPluginPlan({ fleets });
  return writeFleetPluginRows({ dirs: dirs(dir), rows: plan.rows });
}

function withoutNetwork(fn) {
  const original = net.connect;
  let calls = 0;
  net.connect = function stubbed(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    return fn();
  } finally {
    net.connect = original;
    assert.equal(calls, 0, "landing must never open a socket (offline supply)");
  }
}

test("the plan gives one row per plugin, with declaring teams sorted", () => {
  const plan = computeFleetPluginPlan({
    fleets: [
      { id: "fleet-b", plugins: [{ id: "@acme/pdf-kit" }] },
      { id: "fleet-a", plugins: [{ id: "@acme/pdf-kit" }, { id: "supply-probe" }] },
    ],
  });
  assert.deepEqual(plan.rows, [
    { id: "@acme/pdf-kit", name: "@acme/pdf-kit", fleets: ["fleet-a", "fleet-b"] },
    { id: "supply-probe", name: "supply-probe", fleets: ["fleet-a"] },
  ]);
  assert.deepEqual(plan.blockers, []);
});

test("rows land as plain loader entries and the platform's own row survives", () => {
  withoutNetwork(() => {
    const dir = home();
    land(dir, [{ id: "fleet-a", plugins: [{ id: "@acme/pdf-kit" }] }]);
    const rows = patchRows(dir);
    const team = rows.find((r) => r.id === "@acme/pdf-kit");
    assert.deepEqual(team, { id: "@acme/pdf-kit", name: "@acme/pdf-kit" }, "no extra keys on a loader row");
    assert.ok(rows.some((r) => r.id === "sdk-jsonrpc-server"), "the scaffold insert is untouched");
  });
});

test("landing twice is byte-identical (idempotent by recompute)", () => {
  withoutNetwork(() => {
    const dir = home();
    const fleets = [{ id: "fleet-a", plugins: [{ id: "@acme/pdf-kit" }, { id: "supply-probe" }] }];
    land(dir, fleets);
    const first = readFileSync(path.join(dir, "profiles", "platform", "cordis.patch.yml"), "utf8");
    const firstLedger = readFileSync(path.join(dir, "profiles", "platform", "fleet-plugins.json"), "utf8");
    land(dir, fleets);
    assert.equal(readFileSync(path.join(dir, "profiles", "platform", "cordis.patch.yml"), "utf8"), first);
    assert.equal(readFileSync(path.join(dir, "profiles", "platform", "fleet-plugins.json"), "utf8"), firstLedger);
    assert.equal(patchRows(dir).filter((r) => r.name !== "@deepseek-ai/dsh-sdk-jsonrpc-server").length, 2);
  });
});

test("a team that drops a plugin loses exactly that row", () => {
  withoutNetwork(() => {
    const dir = home();
    land(dir, [{ id: "fleet-a", plugins: [{ id: "@acme/pdf-kit" }, { id: "supply-probe" }] }]);
    land(dir, [{ id: "fleet-a", plugins: [{ id: "@acme/pdf-kit" }] }]);
    const ids = patchRows(dir).map((r) => r.id).sort();
    assert.deepEqual(ids, ["@acme/pdf-kit", "sdk-jsonrpc-server"]);
    assert.deepEqual(readFleetPluginRows(dirs(dir)).map((r) => r.id), ["@acme/pdf-kit"]);
  });
});

test("a shared plugin survives the first archive and goes with the second", () => {
  withoutNetwork(() => {
    const dir = home();
    land(dir, [
      { id: "fleet-a", plugins: [{ id: "pdf-kit" }] },
      { id: "fleet-b", plugins: [{ id: "pdf-kit" }] },
    ]);
    assert.deepEqual(readFleetPluginRows(dirs(dir))[0].fleets, ["fleet-a", "fleet-b"]);

    // fleet-a archived: fleet-b still declares it → the row stays.
    land(dir, [{ id: "fleet-b", plugins: [{ id: "pdf-kit" }] }]);
    assert.deepEqual(readFleetPluginRows(dirs(dir)).map((r) => r.id), ["pdf-kit"]);
    assert.deepEqual(readFleetPluginRows(dirs(dir))[0].fleets, ["fleet-b"]);

    // fleet-b archived too → nobody declares it → the row goes.
    land(dir, []);
    assert.deepEqual(readFleetPluginRows(dirs(dir)), []);
    assert.deepEqual(patchRows(dir).map((r) => r.id), ["sdk-jsonrpc-server"]);
  });
});

test("removals are exactly the ledger entries the plan dropped", () => {
  assert.deepEqual(rowsToRemove({ managedIds: ["a", "b", "c"], rows: [{ id: "b" }, { id: "d" }] }), ["a", "c"]);
  // No ledger = no ownership claimed = nothing removed (first run never guesses).
  assert.deepEqual(rowsToRemove({ managedIds: null, rows: [] }), []);
});

test("the ledger is stable and carries the declaring teams", () => {
  const ledger = ledgerFromPlan({
    rows: [
      { id: "b", name: "b", fleets: ["f2", "f1"] },
      { id: "a", name: "a", fleets: ["f1"] },
    ],
  });
  assert.deepEqual(Object.keys(ledger.plugins), ["a", "b"]);
  assert.deepEqual(ledger.plugins.b.fleets, ["f2", "f1"]);
});

test("the read face only reports rows the ledger accounts for", () => {
  const rows = effectiveRows({
    patchRows: [{ id: "declared" }, { id: "hand-edited" }],
    ledger: { plugins: { declared: { name: "declared", fleets: ["f1"] } } },
  });
  assert.deepEqual(rows.map((r) => r.id), ["declared"]);
});

test("a plugin that registers a model route is refused even as a team plugin", () => {
  const dir = home();
  assert.throws(
    () =>
      writeFleetPluginRows({
        dirs: dirs(dir),
        rows: [{ id: "vendor-llm", name: "@acme/dsh-llm-router", fleets: ["f1"] }],
      }),
    (err) => err.code === "dsh_route_exclusivity_violation",
  );
});

test("an existing llm route row is preserved by a plugin landing", () => {
  withoutNetwork(() => {
    const dir = home();
    const patchPath = path.join(dir, "profiles", "platform", "cordis.patch.yml");
    const doc = yaml.load(readFileSync(patchPath, "utf8"));
    doc.push({ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai", config: { providers: { volces: {} } } });
    writeFileSync(patchPath, yaml.dump(doc));
    land(dir, [{ id: "fleet-a", plugins: [{ id: "supply-probe" }] }]);
    const rows = patchRows(dir).map((r) => r.id).sort();
    assert.deepEqual(rows, ["llm-pi-ai", "sdk-jsonrpc-server", "supply-probe"]);
  });
});

// ── the bridge from a fleet row to the patch (2.1 / 2.4 / 2.5) ───────────────

function packRegistry(packs) {
  return (packId) => packs[packId] ?? null;
}

test("a fleet declares its template pack's plugins; an archived fleet declares none", () => {
  const getInstalledPack = packRegistry({
    "pack-pdf": { version: 1, manifest: { plugins: [{ id: "@acme/pdf-kit" }] } },
  });
  const live = declaredPluginsForFleet({ fleet: { id: "f1", sourceTemplate: { packId: "pack-pdf" } }, getInstalledPack });
  assert.deepEqual(live, { id: "f1", plugins: [{ id: "@acme/pdf-kit" }] });
  // Uninstalled pack: the team cannot run its skills either, so it declares
  // nothing rather than keeping only the plugin half.
  const gone = declaredPluginsForFleet({ fleet: { id: "f1", sourceTemplate: { packId: "pack-gone" } }, getInstalledPack });
  assert.deepEqual(gone.plugins, []);
});

test("materializing over live fleets writes their rows and skips archived ones", () => {
  withoutNetwork(() => {
    const dir = home();
    const getInstalledPack = packRegistry({
      "pack-pdf": { version: 1, manifest: { plugins: [{ id: "pdf-kit" }] } },
      "pack-legal": { version: 1, manifest: { plugins: [{ id: "legal-kit" }] } },
    });
    const fleets = [
      { id: "f-live", state: "active", sourceTemplate: { packId: "pack-pdf" } },
      { id: "f-gone", state: "archived", sourceTemplate: { packId: "pack-legal" } },
    ];
    const out = materializeFleetPlugins({ fleets, getInstalledPack, dirs: dirs(dir) });
    assert.deepEqual(out.rows.map((r) => r.id), ["pdf-kit"]);
    assert.deepEqual(patchRows(dir).map((r) => r.id).sort(), ["pdf-kit", "sdk-jsonrpc-server"]);
  });
});

test("the read face shows a team its own plugins and who else shares them", () => {
  const effective = [
    { id: "pdf-kit", name: "pdf-kit", fleets: ["f1", "f2"] },
    { id: "legal-kit", name: "legal-kit", fleets: ["f2"] },
  ];
  assert.deepEqual(fleetPluginView({ fleet: { id: "f1", plugins: [{ id: "pdf-kit" }] }, effective }), [
    { id: "pdf-kit", name: "pdf-kit", sharedWith: ["f2"] },
  ]);
  // A declared plugin that is not effective is not shown as effective (3.2).
  assert.deepEqual(fleetPluginView({ fleet: { id: "f1", plugins: [{ id: "ghost" }] }, effective }), []);
});

// ── regression guard (5.1) ──────────────────────────────────────────────────
// `writeLlmProfile` owns exactly two row ids (llm-pi-ai / spill-policy). If
// someone widens that filter — "clean up unknown rows", say — a routine model
// write would silently delete every team plugin row. This is the assertion that
// catches that future edit.

test("a model write keeps the team's plugin rows", async () => {
  const dir = home();
  // `land` takes FLEETS; the row comes out of the plan (passing a row here
  // would compute an empty plan and prove nothing).
  land(dir, [{ id: "f1", plugins: [{ id: "pdf-kit" }] }]);
  assert.deepEqual(readFleetPluginRows(dirs(dir)).map((r) => r.id), ["pdf-kit"], "precondition: the row landed");
  // No provider keys: the write composes the empty-provider shape and never
  // reaches out to a model. (Discovery lives on the dsh side, not here.)
  const saved = { LLM_API_KEY: process.env.LLM_API_KEY, LLM_BASE_URL: process.env.LLM_BASE_URL };
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  try {
    await writeLlmProfile({ dirs: dirs(dir), llmApiKey: "" });
  } finally {
    if (saved.LLM_API_KEY !== undefined) process.env.LLM_API_KEY = saved.LLM_API_KEY;
    if (saved.LLM_BASE_URL !== undefined) process.env.LLM_BASE_URL = saved.LLM_BASE_URL;
  }
  const ids = patchRows(dir).map((r) => r.id).sort();
  assert.ok(ids.includes("pdf-kit"), `team row survived the model write (saw: ${ids.join(", ")})`);
  assert.ok(ids.includes("llm-pi-ai"), "the platform's own route row is there");
  assert.ok(ids.includes("sdk-jsonrpc-server"), "the scaffold insert is there");
});
