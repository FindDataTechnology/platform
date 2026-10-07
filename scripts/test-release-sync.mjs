// release-sync (add-desktop-release tasks 2.1/2.2). Pure-function tests: the
// asset→entry mapping (D3), the site-mirroring snapshot validation (the three
// break classes the download-center spec requires), merge idempotency, and
// semver ordering. The runner (gh/git/rsync) is exercised for real in task 5.1.

import test from "node:test";
import assert from "node:assert/strict";
import { mapAssetsToEntry, mergeSnapshot, validateSnapshot, compareSemver } from "./release-sync.mjs";

const release = {
  tag_name: "v1.3.0",
  html_url: "https://github.com/FindDataTechnology/platform/releases/tag/v1.3.0",
  published_at: "2026-10-08T03:14:15Z",
  assets: [
    { name: "Platform-1.3.0-arm64.dmg", browser_download_url: "https://github.com/FindDataTechnology/platform/releases/download/v1.3.0/Platform-1.3.0-arm64.dmg" },
    { name: "Platform-1.3.0-x64.dmg", browser_download_url: "https://github.com/FindDataTechnology/platform/releases/download/v1.3.0/Platform-1.3.0-x64.dmg" },
    { name: "Platform Setup 1.3.0.exe", browser_download_url: "https://github.com/FindDataTechnology/platform/releases/download/v1.3.0/Platform%20Setup%201.3.0.exe" },
  ],
};

test("asset mapping: macos links the arm64 dmg + the Release page; windows links the exe; x64 rides along unlinked", () => {
  const entry = mapAssetsToEntry(release, {});
  assert.equal(entry.version, "1.3.0");
  assert.equal(entry.released_at, "2026-10-08");
  assert.deepEqual(entry.platforms.macos, {
    beta: false,
    filename: "Platform-1.3.0-arm64.dmg",
    official_url: null,
    github_url: "https://github.com/FindDataTechnology/platform/releases/tag/v1.3.0",
  });
  assert.deepEqual(entry.platforms.windows, {
    beta: false,
    filename: "Platform Setup 1.3.0.exe",
    official_url: null,
    github_url: "https://github.com/FindDataTechnology/platform/releases/download/v1.3.0/Platform%20Setup%201.3.0.exe",
  });
  assert.deepEqual(entry._syncOnlyAssets, ["Platform-1.3.0-x64.dmg"]);
});

test("asset mapping: --dl-live fills official urls from the dl base; beta flags land per platform", () => {
  const entry = mapAssetsToEntry(release, { dlLive: true, dlBase: "https://dl.finddatatech.cloud", beta: new Set(["windows"]) });
  assert.equal(entry.platforms.macos.official_url, "https://dl.finddatatech.cloud/platform/1.3.0/Platform-1.3.0-arm64.dmg");
  assert.equal(entry.platforms.windows.official_url, "https://dl.finddatatech.cloud/platform/1.3.0/Platform%20Setup%201.3.0.exe");
  assert.equal(entry.platforms.macos.beta, false);
  assert.equal(entry.platforms.windows.beta, true);
});

test("asset mapping: missing assets fail naming them; non-semver tags refuse", () => {
  const partial = { ...release, assets: release.assets.filter((a) => !a.name.includes("exe")) };
  assert.throws(() => mapAssetsToEntry(partial, {}), /missing assets: Platform Setup 1\.3\.0\.exe/);
  // The x64 dmg is dl-host-only (_syncOnlyAssets): its absence is not a failure.
  const noDmg = { ...release, assets: release.assets.filter((a) => !a.name.includes("dmg")) };
  assert.throws(() => mapAssetsToEntry(noDmg, {}), /missing assets: Platform-1\.3\.0-arm64\.dmg/);
  assert.throws(() => mapAssetsToEntry({ ...release, tag_name: "main" }, {}), /not a v<semver> tag/);
});

test("validateSnapshot: the three site break classes are rejected with the offending entry named", () => {
  const entry = () => mapAssetsToEntry(release, {});
  const missing = mergeSnapshot(null, entry());
  delete missing.releases[0].released_at;
  assert.throws(() => validateSnapshot(missing), /"1\.3\.0".*released_at/);

  const unknownKey = mergeSnapshot(null, entry());
  unknownKey.releases[0].platforms.linux = { beta: false, github_url: "https://x.example/a" };
  assert.throws(() => validateSnapshot(unknownKey), /unknown platform key "linux"/);

  const linkless = mergeSnapshot(null, entry());
  linkless.releases[0].platforms.windows.github_url = null;
  assert.throws(() => validateSnapshot(linkless), /windows.*neither an official_url nor a github_url/);
});

test("validateSnapshot: a well-formed merged snapshot passes (mirror of the live site file)", () => {
  const snap = mergeSnapshot({ schema: 1, releases: [] }, mapAssetsToEntry(release, {}));
  assert.deepEqual(validateSnapshot(snap), snap);
});

test("merge: newest-first ordering, same-version replace (re-runs converge), unknown fields dropped from the entry", () => {
  const v130 = mergeSnapshot(null, mapAssetsToEntry(release, {}));
  const bump = (name) => name.replaceAll("1.3.0", "1.4.0");
  const newer = mapAssetsToEntry(
    { ...release, tag_name: "v1.4.0", published_at: "2026-11-01T00:00:00Z", assets: release.assets.map((a) => ({ ...a, name: bump(a.name), browser_download_url: bump(a.browser_download_url) })) },
    {},
  );
  const snap = mergeSnapshot(v130, newer);
  assert.deepEqual(snap.releases.map((r) => r.version), ["1.4.0", "1.3.0"]);

  const rerun = mergeSnapshot(snap, mapAssetsToEntry(release, { beta: new Set(["windows"]) }));
  assert.equal(rerun.releases.length, 2); // no duplicate v1.3.0
  assert.equal(rerun.releases[1].version, "1.3.0");
  assert.equal(rerun.releases[1].platforms.windows.beta, true); // replaced wholesale
  assert.ok(!("_syncOnlyAssets" in rerun.releases[1])); // writer-internal field never lands
});

test("semver compare across patch/minor/major and prerelease suffixes", () => {
  assert.ok(compareSemver("1.10.0", "1.9.9") > 0);
  assert.ok(compareSemver("2.0.0", "1.99.99") > 0);
  assert.equal(compareSemver("1.3.0", "1.3.0"), 0);
  assert.ok(compareSemver("1.3.0", "1.3.0-beta.1") === 0); // suffixes ignored for ordering — same base version
});
