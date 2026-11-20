// Unit tests for the mirror drift sampler (openspec:
// add-unified-memory-and-outputs, task 5.3).
//
// diffMirror is the whole judgement: which rows count as "touched", and what
// counts as drift. The four drift kinds are the four ways the mirror can lie,
// so each gets a case, plus the quiet case (untouched row → no noise).
//
//   node --test scripts/test-memory-mirror-check.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { diffMirror, checkMirror } = await import("./check-memory-mirror.mjs");

const row = (over = {}) => ({ id: "res-1", title: "政策草稿", tier: "draft", tags: "[]", memoryRefPath: null, ...over });
const page = (over = {}) => ({ path: "default/references/r-res-1.md", title: "政策草稿", tier: "draft", tags: [], type: "reference", ...over });
const REF = "default/references/r-res-1.md";

test("an untouched row is silent", () => {
  assert.deepEqual(diffMirror([row()], []), []);
});

test("row graded without a page is mirror_without_page", () => {
  const drift = diffMirror([row({ tier: "canonical" })], []);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, "mirror_without_page");
});

test("a row that only carries tags still counts as touched", () => {
  const drift = diffMirror([row({ tags: '["行业政策"]' })], []);
  assert.equal(drift[0].kind, "mirror_without_page");
});

test("page missing behind a claimed reference", () => {
  const drift = diffMirror([row({ memoryRefPath: REF, tier: "stable" })], []);
  assert.equal(drift[0].kind, "page_missing");
  assert.equal(drift[0].detail, REF);
});

test("a path outside the reference lane is its own finding", () => {
  const drift = diffMirror([row({ memoryRefPath: "default/notes/2026.md", tier: "stable" })], []);
  assert.equal(drift[0].kind, "path_outside_lane");
});

test("tier disagreement is reported with both sides", () => {
  const drift = diffMirror([row({ memoryRefPath: REF, tier: "canonical" })], [page({ tier: "stable" })]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, "tier_drift");
  assert.match(drift[0].detail, /row=canonical page=stable/);
});

test("tag sets compare as sets, not as strings", () => {
  const clean = diffMirror(
    [row({ memoryRefPath: REF, tags: '["b","a"]', tier: "stable" })],
    [page({ tags: ["a", "b"], tier: "stable" })],
  );
  assert.deepEqual(clean, [], "ordering must not read as drift");
  const dirty = diffMirror(
    [row({ memoryRefPath: REF, tags: '["a","b"]', tier: "stable" })],
    [page({ tags: ["a"], tier: "stable" })],
  );
  assert.equal(dirty[0].kind, "tags_drift");
});

test("an agreeing row/page pair reports nothing", () => {
  const drift = diffMirror(
    [row({ memoryRefPath: REF, tier: "canonical", tags: '["行业政策"]' })],
    [page({ tier: "canonical", tags: ["行业政策"] })],
  );
  assert.deepEqual(drift, []);
});

test("checkMirror pages through /memory and joins by path", async () => {
  const rows = [row({ memoryRefPath: REF, tier: "canonical" })];
  const db = { listResources: ({ offset }) => (offset === 0 ? { items: rows } : { items: [] }) };
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ({ items: [{ ...page({ tier: "canonical" }), path: REF }] }) };
  };
  const report = await checkMirror({ db, base: "http://memory.stub", token: "t", rootKey: "u-owner@example.com", fetchImpl });
  assert.equal(report.rows, 1);
  assert.equal(report.pages, 1);
  assert.deepEqual(report.drift, []);
  assert.match(seen[0], /\/memory\?rootKey=u-owner%40example\.com&project=default&limit=200&offset=0/);
});

test("checkMirror refuses to guess when /memory fails", async () => {
  const db = { listResources: () => ({ items: [] }) };
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => checkMirror({ db, base: "http://memory.stub", token: "t", rootKey: "u-x", fetchImpl }), /\/memory HTTP 503/);
});
