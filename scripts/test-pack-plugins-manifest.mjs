// Unit tests — team plugin references (change add-fleet-plugin-declaration,
// tasks 1.1 / 1.2 / 1.3).
// Run: node --test scripts/test-pack-plugins-manifest.mjs
//
// Four shape cases in both directions, then the install-face check:
//   · a reference names an id (and optionally an exact version) — nothing else;
//   · a declared-but-absent id fails loudly instead of installing a half-working
//     team;
//   · a version that is not the baked one fails with BOTH versions named;
//   · the whole check runs with zero network: the cases stub `net.connect` and
//     assert it was never called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import {
  validatePluginsSection,
  checkPluginSupply,
  describePluginSupplyFailure,
  pluginSupplyOk,
  readBakedVersions,
} from "../lib/pack-plugins.js";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { installPack } from "../pack-store.js";

const tmp = mkdtempSync(path.join(tmpdir(), "pack-plugins-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

/** Every case below runs inside this: no socket may be opened. */
function withoutNetwork(fn) {
  const original = net.connect;
  let calls = 0;
  net.connect = function stubbed(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    const result = fn();
    assert.equal(calls, 0, "plugin reference checks must not touch the network");
    return result;
  } finally {
    net.connect = original;
  }
}

function manifestWith(plugins) {
  return {
    name: "Acme Desk",
    version: 1,
    description: "a team that needs two baked plugins",
    skills: [],
    agents: [],
    plugins,
  };
}

// ── shape (publish face) ────────────────────────────────────────────────────

test("a valid reference passes and stays byte-identical when absent", () => {
  withoutNetwork(() => {
    assert.deepEqual(validatePluginsSection([{ id: "@acme/pdf-kit" }, { id: "supply-probe", version: "0.0.1" }]), []);
    assert.deepEqual(validatePluginsSection(undefined), []);
    // Absent ⇒ the manifest carries no plugins key at all after install.
    const errors = validatePackManifest(manifestWith(undefined));
    assert.deepEqual(errors.filter((e) => String(e.code || "").startsWith("plugin")), []);
  });
});

test("a reference carrying a source instead of an id is refused by key name", () => {
  withoutNetwork(() => {
    for (const key of ["url", "registryName", "tarball", "package", "env"]) {
      const errors = validatePluginsSection([{ id: "supply-probe", [key]: "x" }]);
      assert.equal(errors.length, 1, `key ${key} must be refused`);
      assert.equal(errors[0].code, "plugin_forbidden_keys");
      assert.match(errors[0].error, new RegExp(key));
    }
  });
});

test("malformed ids, versions and duplicates are refused with their path", () => {
  withoutNetwork(() => {
    const errors = validatePluginsSection([
      { id: "not a name" },
      { id: "ok-one", version: "^1.0.0" },
      { id: "ok-one" },
      { id: "ok-two", version: "1.0" },
    ]);
    const codes = errors.map((e) => e.code).sort();
    assert.deepEqual(codes, ["plugin_duplicate", "plugin_id_invalid", "plugin_version_invalid", "plugin_version_invalid"]);
    assert.ok(errors.every((e) => typeof e.path === "string" && e.path.startsWith("plugins[")));
  });
});

test("the 8-entry ceiling is a policy value the operator can retune", () => {
  withoutNetwork(() => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `p-${i}` }));
    assert.equal(validatePluginsSection(nine)[0].code, "plugins_too_many");
    assert.deepEqual(validatePluginsSection(nine, { maxPlugins: 12 }), []);
  });
});

test("the manifest validator applies the same rules (one list, two readers)", () => {
  withoutNetwork(() => {
    const errors = validatePackManifest(manifestWith([{ id: "supply-probe", url: "https://evil.test/x.tgz" }]));
    const pluginErrors = errors.filter((e) => e.code === "plugin_forbidden_keys");
    assert.equal(pluginErrors.length, 1);
  });
});

// ── supply (install face) ───────────────────────────────────────────────────

const ROSTER = [{ id: "supply-probe", enabled: true }, { id: "@acme/pdf-kit", enabled: false }];
const BAKED = new Map([
  ["supply-probe", "0.0.1"],
  ["@acme/pdf-kit", "1.2.0"],
]);

test("a reference that hits the roster with the baked version passes", () => {
  withoutNetwork(() => {
    const res = checkPluginSupply({
      declared: [{ id: "supply-probe", version: "0.0.1" }, { id: "@acme/pdf-kit" }],
      roster: ROSTER,
      bakedVersions: BAKED,
    });
    assert.ok(pluginSupplyOk(res));
    assert.deepEqual(res.missing, []);
    assert.deepEqual(res.mismatches, []);
  });
});

test("a declared plugin the deployment does not carry fails by name", () => {
  withoutNetwork(() => {
    const res = checkPluginSupply({ declared: [{ id: "@acme/ghost" }], roster: ROSTER, bakedVersions: BAKED });
    assert.deepEqual(res.missing, ["@acme/ghost"]);
    assert.equal(pluginSupplyOk(res), false);
    const message = describePluginSupplyFailure(res);
    assert.match(message, /not supplied by this deployment: @acme\/ghost/);
    assert.match(message, /never installs a plugin/);
  });
});

test("a version that is not the baked one fails and names both versions", () => {
  withoutNetwork(() => {
    const res = checkPluginSupply({
      declared: [{ id: "@acme/pdf-kit", version: "1.3.0" }],
      roster: ROSTER,
      bakedVersions: BAKED,
    });
    assert.equal(res.mismatches.length, 1);
    assert.deepEqual(res.mismatches[0], { id: "@acme/pdf-kit", declared: "1.3.0", baked: "1.2.0" });
    assert.match(describePluginSupplyFailure(res), /declares version 1\.3\.0 but this deployment bakes 1\.2\.0/);
  });
});

test("an unreadable baked version is not treated as a match", () => {
  withoutNetwork(() => {
    const res = checkPluginSupply({
      declared: [{ id: "supply-probe", version: "0.0.1" }],
      roster: ROSTER,
      bakedVersions: new Map(),
    });
    assert.equal(res.mismatches.length, 1);
    assert.equal(res.mismatches[0].baked, null);
    assert.match(describePluginSupplyFailure(res), /baked version could not be read/);
  });
});

test("an unversioned reference only needs the id to be present", () => {
  withoutNetwork(() => {
    const res = checkPluginSupply({ declared: [{ id: "supply-probe" }], roster: ROSTER, bakedVersions: new Map() });
    assert.ok(pluginSupplyOk(res));
  });
});

test("baked versions are read from the installed tree, first root that has it", () => {
  const rootA = path.join(tmp, "a", "node_modules");
  const rootB = path.join(tmp, "b", "node_modules");
  mkdirSync(path.join(rootA, "supply-probe"), { recursive: true });
  mkdirSync(path.join(rootB, "@acme", "pdf-kit"), { recursive: true });
  writeFileSync(path.join(rootA, "supply-probe", "package.json"), JSON.stringify({ name: "supply-probe", version: "0.0.1" }));
  writeFileSync(path.join(rootB, "@acme", "pdf-kit", "package.json"), JSON.stringify({ name: "@acme/pdf-kit", version: "1.2.0" }));

  withoutNetwork(() => {
    const versions = readBakedVersions({ roots: [rootA, rootB], ids: ["supply-probe", "@acme/pdf-kit", "@acme/ghost"] });
    assert.equal(versions.get("supply-probe"), "0.0.1");
    assert.equal(versions.get("@acme/pdf-kit"), "1.2.0");
    assert.equal(versions.has("@acme/ghost"), false);
  });
});

// ── publish face vs install face ────────────────────────────────────────────

test("the publish face checks the shape only — an id nobody bakes still publishes", () => {
  // The publishing machine has no roster. Making publishing depend on the
  // publisher's machine would mean a pack can be authored but not shipped;
  // supply is proven at INSTALL time, on the machine that will run it.
  withoutNetwork(() => {
    const errors = validatePackManifest(manifestWith([{ id: "@nobody/not-baked-anywhere", version: "9.9.9" }]));
    assert.deepEqual(errors.filter((e) => String(e.code || "").startsWith("plugin")), []);
  });
});

// ── install face: fail closed ───────────────────────────────────────────────
// installPack refuses BEFORE materializing anything, so these assertions need
// no database: the refusals are structural.

function installableManifest(plugins) {
  return {
    name: "Plugin Pack",
    version: 1,
    description: "a pack that needs one plugin",
    skills: [{ name: "s-one", description: "x", content: "hi" }],
    plugins,
  };
}

test("install refuses when the deployment cannot read its roster", async () => {
  await assert.rejects(
    () => installPack({ packId: "p1", version: 1, manifest: installableManifest([{ id: "@acme/ghost" }]), user: null }),
    (err) => err.status === 409 && err.code === "plugin-roster-unavailable",
  );
});

test("install refuses a plugin the roster does not carry", async () => {
  await assert.rejects(
    () =>
      installPack({
        packId: "p1",
        version: 1,
        manifest: installableManifest([{ id: "@acme/ghost" }]),
        user: null,
        pluginSupply: { roster: [{ id: "supply-probe" }], bakedVersions: new Map() },
      }),
    (err) => err.status === 409 && err.code === "plugin-supply-missing" && /@acme\/ghost/.test(err.message),
  );
});

test("install refuses a version that is not the baked one, naming both", async () => {
  await assert.rejects(
    () =>
      installPack({
        packId: "p1",
        version: 1,
        manifest: installableManifest([{ id: "@acme/ghost", version: "1.1.0" }]),
        user: null,
        pluginSupply: { roster: [{ id: "@acme/ghost" }], bakedVersions: new Map([["@acme/ghost", "1.0.0"]]) },
      }),
    (err) => err.status === 409 && err.code === "plugin-supply-missing" && /1\.1\.0/.test(err.message) && /1\.0\.0/.test(err.message),
  );
});
