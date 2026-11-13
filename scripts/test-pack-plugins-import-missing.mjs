// Unit tests — import/export of a team's plugin declaration (change
// add-fleet-plugin-declaration, tasks 4.1 / 4.2).
// Run: node --test scripts/test-pack-plugins-import-missing.mjs
//
// Two directions again, because they fail differently:
//   · EXPORT must carry the declaration verbatim — a template that loses its
//     plugins still imports cleanly and then runs a team that cannot work;
//   · IMPORT must refuse the whole thing when anything is missing, listing
//     EVERY missing id at once (one round-trip, not one per plugin) and leaving
//     the installed set exactly as it was.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-import-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb, listInstalledPacks } = await import("../db.js");
const { installPack } = await import("../pack-store.js");
const { exportFleetToTemplate } = await import("../server/fleet-template.js");

await initDb();

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const FLEET = { id: "f1", name: "PDF Desk", orchestration: null };
const MEMBERS = [
  { id: "m1", title: "Lead", parentId: null, targetKind: "persona", targetId: "persona-1", kpiSlots: ["done"] },
];

function manifestWith(plugins) {
  return {
    name: "Plugin Team",
    version: 1,
    description: "a team that needs plugins",
    skills: [{ name: "s-one", description: "x", content: "hi" }],
    plugins,
  };
}

test("export carries the declaration verbatim (and omits it when empty)", () => {
  const exported = exportFleetToTemplate(FLEET, MEMBERS, {
    plugins: [{ id: "pdf-kit" }, { id: "@acme/legal-kit", version: "2.1.0" }],
  });
  assert.deepEqual(exported.fleet.plugins, [{ id: "pdf-kit" }, { id: "@acme/legal-kit", version: "2.1.0" }]);

  // Absent ⇒ byte-identical to the pre-change export.
  const plain = exportFleetToTemplate(FLEET, MEMBERS);
  assert.equal("plugins" in plain.fleet, false);
});

test("import refuses the whole pack and lists every missing plugin at once", async () => {
  await assert.rejects(
    () =>
      installPack({
        packId: "pack-needs-plugins",
        version: 1,
        manifest: manifestWith([{ id: "pdf-kit" }, { id: "@acme/legal-kit" }]),
        user: null,
        pluginSupply: { roster: [{ id: "supply-probe" }], bakedVersions: new Map() },
      }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, "plugin-supply-missing");
      // One message, every id — the operator fixes one round-trip.
      assert.match(err.message, /pdf-kit/);
      assert.match(err.message, /@acme\/legal-kit/);
      assert.deepEqual([...err.details.missing].sort(), ["@acme/legal-kit", "pdf-kit"]);
      return true;
    },
  );
});

test("a refused import leaves the installed set unchanged", async () => {
  const before = listInstalledPacks().map((p) => `${p.packId}@${p.version}`).sort();
  await assert.rejects(() =>
    installPack({
      packId: "pack-needs-plugins",
      version: 1,
      manifest: manifestWith([{ id: "ghost-plugin" }]),
      user: null,
      pluginSupply: { roster: [], bakedVersions: new Map() },
    }),
  );
  const after = listInstalledPacks().map((p) => `${p.packId}@${p.version}`).sort();
  assert.deepEqual(after, before, "a failed import must not materialize anything");
});

test("a pack with no plugin declaration is unaffected by the gate", async () => {
  // No plugins key ⇒ the whole check is skipped, byte-identical to before the
  // change. Proven by the refusal NOT happening even with no roster at all.
  await assert.rejects(
    () =>
      installPack({
        packId: "pack-plain",
        version: 1,
        // Zero references: the pack validator refuses an empty pack, so this
        // still throws — but with the CONTRACT error, not a plugin error. That
        // distinction is the assertion: the plugin gate is not in the way.
        manifest: { name: "Plain", version: 1, description: "d", skills: [] },
        user: null,
      }),
    (err) => err.code !== "plugin-roster-unavailable" && err.code !== "plugin-supply-missing",
  );
});
