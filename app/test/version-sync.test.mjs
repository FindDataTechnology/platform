// Version single source (add-mobile-distribution 1.1): the running app reports
// app.json's expo.version, so a package.json that drifted would make the
// download manifest, the artifact name and the in-app "current version" three
// different numbers.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncVersion } from "../scripts/sync-version.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("app.json expo.version and package.json version agree", () => {
  const { version, changed } = syncVersion({ write: false });
  assert.equal(changed, false, `package.json is ${JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")).version}, app.json says ${version} — run node scripts/sync-version.mjs`);
});

test("the synced version is a plain semver (artifact names and the manifest use it verbatim)", () => {
  const { version } = syncVersion({ write: false });
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
