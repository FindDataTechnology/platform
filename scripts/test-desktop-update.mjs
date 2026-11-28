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
  DEFAULT_UPDATE_URL,
  INTERNAL_UPDATE_URL,
} = await import("../electron/updater-core.js");

test("default channel is the public HTTPS lane (tailnet address is only an internal fallback)", () => {
  assert.match(DEFAULT_UPDATE_URL, /^https:\/\//, "a public channel must be HTTPS");
  assert.ok(!/100\.64\./.test(DEFAULT_UPDATE_URL), "no internal address may be the default");
  assert.ok(DEFAULT_UPDATE_URL.endsWith("/platform/lane"), "lane lives beside the public installers");
  // The internal fallback is env-driven: this module ships in the OSS drop, so
  // no internal host may be baked into source.
  assert.equal(INTERNAL_UPDATE_URL, process.env.DESKTOP_UPDATE_INTERNAL_FALLBACK || "");
});

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
  // arch is PINNED: the lane carries an arm64 dmg only, and the update target is
  // chosen by the RUNNING arch (an x64 machine correctly gets no URL). Leaving
  // this implicit made the test pass on an arm64 dev box and fail on the x64 CI
  // runner — the assertion was about URL surfacing, not about arch guessing.
  const r = await macNotifyCheck({ channelUrl: "https://lane/desktop/", currentVersion: "1.3.28", fetchImpl: ok, arch: "arm64" });
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

// ── Architecture-correct target (harden-desktop-release-lane 3.1) ───────────

const LANE_DUAL = `version: 1.3.28
files:
  - url: Platform-1.3.28-arm64.dmg
    sha512: AAAA
    size: 100
  - url: Platform-1.3.28-x64.dmg
    sha512: BBBB
    size: 110
releaseDate: 2026-11-28T00:00:00.000Z
`;

const fetchWith = (body) => async () => ({ ok: true, text: async () => body });

test("x64 machine is pointed at the x64 dmg, not files[0] (the live Intel-Mac bug)", async () => {
  const r = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.27", fetchImpl: fetchWith(LANE_DUAL), arch: "x64", platform: "darwin" });
  assert.equal(r.available, true);
  assert.equal(r.url, "https://lane/Platform-1.3.28-x64.dmg");
  assert.equal(r.archMissing, false);
});

test("arm64 machine gets the arm64 dmg", async () => {
  const r = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.27", fetchImpl: fetchWith(LANE_DUAL), arch: "arm64" });
  assert.equal(r.url, "https://lane/Platform-1.3.28-arm64.dmg");
});

test("no artifact for this arch → version reported, no download path", async () => {
  const onlyArm = LANE_DUAL.replace(/  - url: Platform-1\.3\.28-x64\.dmg\n    sha512: BBBB\n    size: 110\n/, "");
  const r = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.27", fetchImpl: fetchWith(onlyArm), arch: "x64", platform: "darwin" });
  assert.equal(r.available, true);
  assert.equal(r.url, null);
  assert.equal(r.archMissing, true);
});

test("a single-artifact lane is used regardless of its name", async () => {
  const single = `version: 1.3.28\nfiles:\n  - url: Platform-1.3.28.dmg\n    sha512: AAAA\n    size: 100\n`;
  const r = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.27", fetchImpl: fetchWith(single), arch: "x64" });
  assert.equal(r.url, "https://lane/Platform-1.3.28.dmg");
  assert.equal(r.archMissing, false);
});

test("blockMapSize is emitted when known (differential updates), omitted when not", () => {
  const yml = generateLatestYml({
    version: "1.3.28",
    files: [{ file: "Platform Setup 1.3.28.exe", sha512: "AA==", size: 10, blockMapSize: 4096 }],
    releaseDate: "2026-11-28T00:00:00.000Z",
  });
  assert.match(yml, /size: 10\n {4}blockMapSize: 4096/);
  const plain = generateLatestYml({ version: "1.3.28", files: [{ file: "a.exe", sha512: "AA==", size: 10 }] });
  assert.ok(!/blockMapSize/.test(plain));
});

// ── Linux lifecycle (add-linux-desktop-client 2.1/2.2) ──────────────────────

test("Linux auto-updates only when it really is an AppImage", async () => {
  const { autoUpdateSupported, laneMetadataFor } = await import("../electron/updater-core.js");
  assert.equal(autoUpdateSupported({ platform: "linux", appImage: true }), true);
  assert.equal(autoUpdateSupported({ platform: "linux", appImage: false }), false);
  assert.equal(autoUpdateSupported({ platform: "linux" }), false, "no APPIMAGE means no file to swap");
  assert.equal(autoUpdateSupported({ platform: "win32" }), true, "windows path unchanged");
  assert.equal(autoUpdateSupported({ platform: "darwin", signed: false }), false, "unsigned mac path unchanged");
  assert.equal(laneMetadataFor("linux"), "latest-linux.yml");
  assert.equal(laneMetadataFor("darwin"), "latest-mac.yml");
  assert.equal(laneMetadataFor("win32"), "latest.yml");
});

test("Linux notify-only reads latest-linux.yml and never claims a downloaded update", async () => {
  const body = `version: 1.4.0
files:
  - url: Platform-1.4.0-x64.AppImage
    sha512: AAAA
    size: 100
`;
  const seen = [];
  const r = await macNotifyCheck({
    channelUrl: "https://lane",
    currentVersion: "1.3.28",
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, text: async () => body };
    },
    arch: "x64",
    platform: "linux",
    metadata: "latest-linux.yml",
  });
  assert.deepEqual(seen, ["https://lane/latest-linux.yml"]);
  assert.equal(r.available, true);
  assert.equal(r.url, "https://lane/Platform-1.4.0-x64.AppImage");
});

test("the degrade reason names the actual platform, not a mac-only sentence", async () => {
  // updater.js imports electron at module scope and can't load under plain
  // node, so the copy table is asserted at its source.
  const src = (await import("node:fs")).readFileSync(new URL("../electron/updater.js", import.meta.url), "utf8");
  assert.match(src, /platform === "linux" && !appImage/);
  assert.match(src, /不是以 AppImage 运行/);
  assert.match(src, /当前构建未签名/);
  // the renderer must not re-hardcode a platform sentence
  const ui = (await import("node:fs")).readFileSync(new URL("../electron/preferences/renderer/index.html", import.meta.url), "utf8");
  assert.ok(!/未签名，macOS 仅提示/.test(ui), "the static mac sentence must live in the shell, keyed on platform");
});

test("a mixed-up lane never hands a platform the other platform's installer", async () => {
  // One metadata file listing BOTH a dmg and an AppImage: a mac client must
  // still never receive the AppImage (and vice versa). The per-platform yml
  // files make this unlikely, one bad file on the host makes it possible.
  const body = `version: 1.4.0
files:
  - url: Platform-1.4.0-arm64.dmg
    sha512: AAAA
    size: 1
  - url: Platform-1.4.0-x64.AppImage
    sha512: BBBB
    size: 2
`;
  const intake = async () => ({ ok: true, text: async () => body });
  // arm64 mac: the dmg matches, the AppImage never does (the two filters —
  // platform extension, then arch — are independent).
  const mac = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.28", fetchImpl: intake, arch: "arm64", platform: "darwin" });
  assert.equal(mac.url, "https://lane/Platform-1.4.0-arm64.dmg", "a mac client must never be pointed at an AppImage");
  // and an x64 mac gets NOTHING rather than the AppImage or the arm64 dmg
  const macX64 = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.28", fetchImpl: intake, arch: "x64", platform: "darwin" });
  assert.equal(macX64.url, null);
  assert.equal(macX64.archMissing, true);

  const linux = await macNotifyCheck({ channelUrl: "https://lane", currentVersion: "1.3.28", fetchImpl: intake, arch: "x64", platform: "linux", metadata: "latest-linux.yml" });
  assert.equal(linux.url, "https://lane/Platform-1.4.0-x64.AppImage", "a Linux client must never be pointed at a dmg");
});

test("the internal fallback is read from settings and wired into the shell", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../electron/updater.js", import.meta.url), "utf8");
  // A settable fallback nobody reads is a fake affordance — pin both halves.
  assert.match(src, /DESKTOP_UPDATE_INTERNAL_FALLBACK/);
  // Both paths must use it: notify-only (pull) and the auto-update platforms
  // (push, where electron-updater has no fallback of its own).
  assert.match(src, /if \(!mac && fallbackUrl && fallbackUrl !== channelUrl\(\)\)/);
  assert.match(src, /if \(fallbackUrl && fallbackUrl !== feed\)/);
  const keys = readFileSync(new URL("../electron/preferences/window.js", import.meta.url), "utf8");
  assert.match(keys, /"DESKTOP_UPDATE_INTERNAL_FALLBACK"/, "the key must be readable/writable from preferences");
});
