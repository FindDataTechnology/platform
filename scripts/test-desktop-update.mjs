// Desktop in-app update core (add-desktop-in-app-update): pins the lane
// contract and the lifecycle decisions the electron shell rides.
//   - latest.yml generation ↔ parse round-trip (the CI publish step's output
//     is exactly what the client reads — hash consistency is the spec's
//     不匹配拒装 precondition)
//   - version three-way compare (1.3.9 < 1.3.10 — the classic string trap)
//   - the platform gate: win32 auto-updates; unsigned mac degrades to
//     notify-only; signed mac may flip on
//   - mac notify check: lane unreachable → null (silent, no retry storm);
//     older/equal lane version → not available; newer → dmg URL surfaced
//   - generator validation: garbage in → throw, never a malformed yml on the lane
//
// Run: node --test scripts/test-desktop-update.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  parseLatestYml,
  generateLatestYml,
  compareVersions,
  autoUpdateSupported,
  macNotifyCheck,
} = await import("../electron/updater-core.js");

test("generate → parse round-trip: electron-updater's yml shape survives", () => {
  const yml = generateLatestYml({
    version: "1.3.28",
    files: [{ file: "Platform-1.3.28.exe", sha512: "AbCd+/1234=", size: 314572800 }],
    releaseDate: "2026-11-01T12:00:00.000Z",
  });
  assert.match(yml, /^version: 1\.3\.28\nfiles:\n {2}- url: Platform-1\.3\.28\.exe\n {4}sha512: AbCd\+\/1234=\n {4}size: 314572800\npath: Platform-1\.3\.28\.exe\nsha512: AbCd\+\/1234=\nreleaseDate: /);
  const meta = parseLatestYml(yml);
  assert.equal(meta.version, "1.3.28");
  assert.deepEqual(meta.files, [{ url: "Platform-1.3.28.exe", sha512: "AbCd+/1234=", size: "314572800" }]);
});

test("parse reads electron-builder's real multi-file shape (dmg per-arch)", () => {
  const meta = parseLatestYml(`version: 1.3.28
files:
  - url: Platform-1.3.28-arm64.dmg
    sha512: AAAA
    size: 100
  - url: Platform-1.3.28-x64.dmg
    sha512: BBBB
    size: 200
path: Platform-1.3.28-arm64.dmg
sha512: AAAA
releaseDate: 2026-11-01T12:00:00.000Z
`);
  assert.equal(meta.version, "1.3.28");
  assert.equal(meta.files.length, 2);
  assert.equal(meta.files[1].url, "Platform-1.3.28-x64.dmg");
});

test("version compare: numeric segments numerically, 1.3.9 < 1.3.10", () => {
  assert.equal(compareVersions("1.3.9", "1.3.10"), -1);
  assert.equal(compareVersions("1.3.10", "1.3.9"), 1);
  assert.equal(compareVersions("1.4.0", "1.3.99"), 1);
  assert.equal(compareVersions("1.3.28", "1.3.28"), 0);
  assert.equal(compareVersions("2.0", "1.9.9"), 1, "fewer segments with bigger major wins");
  assert.equal(compareVersions("1.3.28", "1.3.28-beta.1"), 1, "release beats prerelease lexically");
});

test("platform gate: win32 yes; unsigned mac notify-only; signed mac may flip on", () => {
  assert.equal(autoUpdateSupported({ platform: "win32" }), true);
  assert.equal(autoUpdateSupported({ platform: "darwin", signed: false }), false);
  assert.equal(autoUpdateSupported({ platform: "darwin", signed: true }), true);
  assert.equal(autoUpdateSupported({ platform: "linux" }), false);
});

test("mac notify check: newer lane surfaces the dmg URL; lane down → null (silent)", async () => {
  const laneYml = `version: 1.4.0
files:
  - url: Platform-1.4.0-arm64.dmg
    sha512: AAAA
    size: 100
path: Platform-1.4.0-arm64.dmg
sha512: AAAA
releaseDate: now
`;
  const ok = async () => ({ ok: true, status: 200, text: async () => laneYml });
  const r = await macNotifyCheck({ channelUrl: "https://lane/desktop/", currentVersion: "1.3.28", fetchImpl: ok });
  assert.equal(r.available, true);
  assert.equal(r.version, "1.4.0");
  assert.equal(r.url, "https://lane/desktop/Platform-1.4.0-arm64.dmg");

  const newer = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.4.0", fetchImpl: ok });
  assert.equal(newer.available, false, "equal lane version → nothing to notify");

  const down = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.equal(await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.28", fetchImpl: down }), null, "unreachable lane degrades silently");
  const http500 = async () => ({ ok: false, status: 500 });
  assert.equal(await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.28", fetchImpl: http500 }), null);
  assert.equal(await macNotifyCheck({ channelUrl: "", currentVersion: "1.3.28", fetchImpl: ok }), null, "no channel → no guess");
});

test("generator validation: garbage in throws — a malformed yml never reaches the lane", () => {
  assert.throws(() => generateLatestYml({ version: "", files: [{ file: "x", sha512: "s", size: 1 }] }));
  assert.throws(() => generateLatestYml({ version: "1.0", files: [] }));
  assert.throws(() => generateLatestYml({ version: "1.0", files: [{ file: "x", sha512: null, size: 1 }] }));
  assert.throws(() => generateLatestYml({ version: "1.0", files: [{ file: "x", sha512: "s", size: "big" }] }));
});

// Regression pin (add-desktop-in-app-update, E2E rounds 1-5): the packaged app
// died silently for five rounds because `import { autoUpdater } from
// "electron-updater"` — a NAMED import of a CJS module whose exports are
// attached via TS's __exportStar/getters — throws SyntaxError at link time and
// takes down main.js's whole import graph. cjs-module-lexer cannot see the
// binding, so the ONLY safe pattern here is the default import (module.exports)
// plus destructuring. This static guard fails the suite if anyone reverts it.
test("updater.js imports electron-updater via DEFAULT (CJS interop), never named", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../electron/updater.js", import.meta.url), "utf8")
    // strip line comments — the guard's own rationale quotes the bad pattern
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(
    !/import\s*\{[^}]*autoUpdater[^}]*\}\s*from\s*["']electron-updater["']/.test(src),
    "named import of electron-updater kills the packaged app (CJS lexer gap) — use the default import",
  );
  assert.match(src, /import\s+electronUpdater\s+from\s*["']electron-updater["']/, "default import of electron-updater required");
});
