// Mobile release sync (add-mobile-distribution 2.1): the manifest is the only
// thing the app reads, so its shape and its promise (every url answers) are
// the contract.

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFormalVersion,
  pickApkAsset,
  buildReleaseEntry,
  mergeManifest,
  deadLinks,
  compareSemver,
} from "./mobile-release-sync.mjs";

const asset = { name: "yizuo-0.2.0.apk", size: 1000, browser_download_url: "https://gh/x.apk" };

test("formal versions only", () => {
  assert.doesNotThrow(() => assertFormalVersion("0.2.0"));
  assert.throws(() => assertFormalVersion("0.2.0-beta"), /pre-releases must not reach/);
  assert.throws(() => assertFormalVersion("0.2"), /not a formal/);
});

test("APK asset: prefers our naming, accepts any single .apk", () => {
  assert.equal(pickApkAsset([asset], "0.2.0").name, "yizuo-0.2.0.apk");
  assert.equal(pickApkAsset([{ name: "app-release.apk", size: 1 }], "0.2.0").name, "app-release.apk");
  assert.throws(() => pickApkAsset([{ name: "a.dmg" }], "0.2.0"), /carries no \.apk asset/);
});

test("entry carries everything a client needs to verify a download", () => {
  const e = buildReleaseEntry({ version: "0.2.0", releasedAt: "2026-11-28", asset, sha256: "ab".repeat(32), size: 1000, dlBase: "https://dl" });
  assert.deepEqual(e, {
    version: "0.2.0",
    released_at: "2026-11-28",
    prerelease: false,
    filename: "yizuo-0.2.0.apk",
    size: 1000,
    sha256: "ab".repeat(32),
    url: "https://dl/app/0.2.0/yizuo-0.2.0.apk",
  });
});

test("manifest: newest-first, same version replaces, pre-releases never land", () => {
  const mk = (v, pre = false) => ({ version: v, released_at: "2026-11-28", prerelease: pre, filename: `yizuo-${v}.apk`, size: 1, sha256: "x", url: `https://dl/app/${v}/a.apk` });
  let m = mergeManifest(null, mk("0.1.0"));
  m = mergeManifest(m, mk("0.2.0"));
  assert.deepEqual(m.releases.map((r) => r.version), ["0.2.0", "0.1.0"]);

  m = mergeManifest(m, mk("0.2.0"));
  assert.equal(m.releases.filter((r) => r.version === "0.2.0").length, 1, "re-run replaces");

  m = mergeManifest(m, mk("0.3.0", true));
  assert.deepEqual(m.releases.map((r) => r.version), ["0.2.0", "0.1.0"], "a pre-release is not published");
});

test("a stale pre-release already in the manifest is dropped on the next publish", () => {
  const existing = { schema: 1, releases: [{ version: "0.3.0", prerelease: true, url: "https://dl/app/0.3.0/a.apk" }, { version: "0.2.0", url: "https://dl/app/0.2.0/a.apk" }] };
  const m = mergeManifest(existing, { version: "0.2.1", released_at: "2026-11-28", prerelease: false, filename: "f", size: 1, sha256: "x", url: "https://dl/app/0.2.1/a.apk" });
  assert.deepEqual(m.releases.map((r) => r.version), ["0.2.1", "0.2.0"]);
});

test("dead links are reported by url", () => {
  const manifest = { schema: 1, releases: [{ version: "0.2.0", url: "https://dl/ok.apk" }, { version: "0.1.0", url: "https://dl/gone.apk" }] };
  assert.deepEqual(deadLinks(manifest, (u) => u.includes("ok")), ["https://dl/gone.apk"]);
});

test("semver ordering across minor/patch", () => {
  assert.ok(compareSemver("0.10.0", "0.9.0") > 0);
  assert.equal(compareSemver("0.2.0", "0.2.0"), 0);
});
