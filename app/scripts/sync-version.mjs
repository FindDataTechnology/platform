#!/usr/bin/env node
// Version single source (add-mobile-distribution D3): app.json's expo.version
// is what the RUNNING app reports (Constants.expoConfig.version), so it is the
// truth; package.json is synced from it. The unit gate
// (test/version-sync.test.mjs) fails if the two ever drift.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function syncVersion({ write = true, dir = appDir } = {}) {
  const version = JSON.parse(readFileSync(path.join(dir, "app.json"), "utf8")).expo.version;
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const changed = pkg.version !== version;
  if (changed && write) {
    pkg.version = version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { version, changed };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const { version, changed } = syncVersion();
  console.log(changed ? `package.json version -> ${version}` : `package.json already at ${version}`);
}
