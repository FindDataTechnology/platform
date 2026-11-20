// Unit tests — facet line board adapter (fix-line-boards-ux, tasks 1.1-1.3).
// Run: node --test scripts/test-facet-line-board.mjs
//
// The 2026-11-02 user audit found the facet board was a hardcoded placeholder
// (weeklyActivePacks: 0 / totalInstalls: 0) with raw English keys rendered on
// the page. These tests pin the replacement contract:
//   1. no credential → the unconnected card (wire's pattern), zero upstream calls;
//   2. connected → my_packs + publish_history + recent_events carry REAL market
//      data; overview_metrics is the honest `under_construction` sentinel (no
//      user-readable install/active endpoint exists);
//   3. every block declares its owning tab (the page's tab contract);
//   4. a 401 clears the credential and flips the board to expired;
//   5. no block JSON anywhere carries the historical fabricated keys.

import test from "node:test";
import assert from "node:assert/strict";

const { FacetBoardAdapter } = await import("../lib/board-adapters.js");

const EMAIL = "author@example.com";
const PACKS = {
  packs: [
    { id: "pk-one", name: "台账助手", description: "进货出货台账", version: 3, visibility: "public", tags: ["finance"] },
    { id: "pk-two", name: "巡线岗", description: "值班巡逻", version: 1, visibility: "private", tags: [] },
  ],
};
const VERSIONS_ONE = {
  versions: [
    { version: 3, publishedAt: "2026-11-01T10:00:00Z", authorEmail: EMAIL, notes: "修尾单" },
    { version: 2, publishedAt: "2026-10-20T10:00:00Z", authorEmail: EMAIL },
  ],
};
const VERSIONS_TWO = { versions: [{ version: 1, publishedAt: "2026-10-28T09:00:00Z", authorEmail: EMAIL }] };

const jsonResponse = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function adapterWith({ token = "tok", fetchImpl, markInvalid = () => {} } = {}) {
  const calls = [];
  const invalidated = [];
  const adapter = new FacetBoardAdapter({
    deps: {
      liveToken: () => token,
      markInvalid: (e) => {
        invalidated.push(e);
        markInvalid(e);
      },
      fetch: async (url, init) => {
        calls.push({ url, auth: init?.headers?.Authorization });
        return fetchImpl(url);
      },
    },
  });
  return { adapter, calls, invalidated };
}

test("1. no credential: unconnected card, zero upstream calls, no private data", async () => {
  const { adapter, calls } = adapterWith({ token: null, fetchImpl: () => jsonResponse({}) });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.equal(calls.length, 0);
  assert.equal(out.connected, false);
  assert.equal(out.reason, "not_connected");
  assert.match(out.connectPath, /panel=facet-market/);
  assert.equal(out.blocks.length, 1);
  assert.equal(out.blocks[0].id, "connection");
});

test("2. connected: real my_packs/publish_history/recent_events; overview honestly under construction", async () => {
  const { adapter } = adapterWith({
    fetchImpl: (url) => {
      if (url.includes("/api/packs?author=me")) return jsonResponse(PACKS);
      if (url.includes("/api/packs/pk-one/versions")) return jsonResponse(VERSIONS_ONE);
      if (url.includes("/api/packs/pk-two/versions")) return jsonResponse(VERSIONS_TWO);
      return jsonResponse({}, 404);
    },
  });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.equal(out.connected, true);

  const byId = Object.fromEntries(out.blocks.map((b) => [b.id, b]));
  // overview: real counts from what this session fetched — the historical
  // fabricated weekly-active/installs zeros are gone (design D4 probe).
  assert.deepEqual(byId.overview_metrics.data, { my_packs: 2, published_versions: 3 });
  assert.equal(byId.overview_metrics.error, undefined);
  // my_packs: real rows from the market's author=me listing.
  assert.deepEqual(byId.my_packs.data.map((r) => r.title), ["台账助手", "巡线岗"]);
  assert.deepEqual(byId.my_packs.data[0].badges, ["v3", "公开"]);
  assert.deepEqual(byId.my_packs.data[1].badges, ["v1", "私有"]);
  // publish_history: merged version rows, newest first.
  assert.deepEqual(
    byId.publish_history.data.map((e) => e.id),
    ["pk-one:3", "pk-two:1", "pk-one:2"],
  );
  // recent_events: derived from the same rows (top 5).
  assert.equal(byId.recent_events.data[0].id, "pk-one:3");
  assert.match(byId.recent_events.data[0].text, /台账助手 · v3 · 修尾单/);
});

test("3. every block declares its owning tab", async () => {
  const { adapter } = adapterWith({
    fetchImpl: (url) => {
      if (url.includes("/api/packs?author=me")) return jsonResponse({ packs: [] });
      return jsonResponse({ versions: [] });
    },
  });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.deepEqual(
    out.blocks.map((b) => [b.id, b.tab]),
    [
      ["overview_metrics", "overview"],
      ["my_packs", "my-packs"],
      ["recent_events", "overview"],
      ["publish_history", "publish-history"],
    ],
  );
});

test("4. upstream 401 clears the credential and returns the expired card", async () => {
  const { adapter, invalidated } = adapterWith({ fetchImpl: () => jsonResponse({ error: "nope" }, 401) });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.deepEqual(invalidated, [EMAIL]);
  assert.equal(out.connected, false);
  assert.equal(out.reason, "expired");
});

test("5. the historical fabricated placeholder keys are gone from the module", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../lib/board-adapters.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /weeklyActivePacks/, "placeholder weeklyActivePacks must be gone");
  assert.doesNotMatch(src, /totalInstalls/, "placeholder totalInstalls must be gone");
  assert.doesNotMatch(src, /TODO: implement real REST/, "the facet TODO must be gone");
});

test("6. pack-list failure degrades per-block, never a fake board", async () => {
  const { adapter } = adapterWith({ fetchImpl: () => jsonResponse({ error: "boom" }, 500) });
  const out = await adapter.fetchBlocks({ email: EMAIL });
  assert.equal(out.connected, true);
  const byId = Object.fromEntries(out.blocks.map((b) => [b.id, b]));
  assert.ok(byId.my_packs.error && byId.my_packs.error !== "under_construction", "my_packs names the failure");
  assert.ok(byId.publish_history.error, "history degrades alone");
  assert.ok(byId.overview_metrics.error, "overview degrades alone — no counts, no fakes");
  assert.equal(byId.overview_metrics.data, undefined);
});
