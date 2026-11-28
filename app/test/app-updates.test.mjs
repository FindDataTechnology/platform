// In-app update check (add-mobile-distribution 3.1/3.2): version comparison,
// formal-only selection, and the "unreachable manifest is quiet" contract.

import test from "node:test";
import assert from "node:assert/strict";
import { judgeUpdate, newestRelease, checkForUpdate, compareVersions } from "../src/lib/app-updates.ts";

const manifest = (versions) => ({ schema: 1, releases: versions.map((v) => ({ version: v, url: `https://dl/app/${v}/yizuo-${v}.apk` })) });

test("semver compare handles multi-digit segments", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
});

test("newest formal release is picked; pre-releases are ignored", () => {
  const m = { schema: 1, releases: [
    { version: "0.3.0", url: "u3", prerelease: true },
    { version: "0.2.0", url: "u2" },
    { version: "0.1.0", url: "u1" },
  ] };
  assert.equal(newestRelease(m).version, "0.2.0");
});

test("a newer manifest version means an update is available, with its url", () => {
  const r = judgeUpdate("0.1.0", manifest(["0.2.0", "0.1.0"]));
  assert.equal(r.status, "available");
  assert.equal(r.latest.version, "0.2.0");
  assert.equal(r.latest.url, "https://dl/app/0.2.0/yizuo-0.2.0.apk");
});

test("an equal or older manifest version is 'current'", () => {
  assert.equal(judgeUpdate("0.2.0", manifest(["0.2.0"])).status, "current");
  assert.equal(judgeUpdate("0.3.0", manifest(["0.2.0"])).status, "current");
});

test("an unreachable manifest yields 'unknown' with a recorded error, never a throw", async () => {
  const r = await checkForUpdate({ currentVersion: "0.1.0", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.status, "unknown");
  assert.match(r.error, /ECONNREFUSED/);
});

test("a non-200 manifest yields 'unknown' rather than pretending to be current", async () => {
  const r = await checkForUpdate({ currentVersion: "0.1.0", fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.equal(r.status, "unknown");
  assert.match(r.error, /503/);
});

test("a malformed manifest body is 'unknown'", async () => {
  const r = await checkForUpdate({ currentVersion: "0.1.0", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }) });
  assert.equal(r.status, "unknown");
});
