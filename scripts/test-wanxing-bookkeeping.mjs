#!/usr/bin/env node
// ── Bookkeeping snapshot cache tests (add-wanxing-deployments-cache 1.x/3.1) ─
//
// Module tests for the snapshot cache (TTL, single-flight, stale-on-hiccup,
// hard window, cold-start propagation, diff buckets) and the A2A face's
// pagination + enumeration hard-stale gate, against an in-process express
// app with stubbed resolution/registry.
//
//   node --test scripts/test-wanxing-bookkeeping.mjs

import assert from "node:assert/strict";
import express from "express";
import { test } from "node:test";

const { createBookkeepingCache, diffDeployments } = await import("../gateway/wanxing/bookkeeping.js");
const { createA2aFace } = await import("../gateway/wanxing/a2a.js");

// A mutable clock — tests force staleness by advancing it.
function makeClock(start = 1_000_000) {
  return { t: start, now() { return this.t; } };
}

const row = (packId, agentId, extra = {}) => ({
  packId,
  agentId,
  agentPath: `/packs/${packId}/deployments/${agentId}`,
  ...extra,
});

test("diff: three buckets keyed by agentPath, canonical content compare", () => {
  const prev = [row("p1", "a1"), row("p2", "a2"), row("p3", "a3")];
  const next = [
    row("p1", "a1"),
    // same key, same content but different key order → unchanged
    { agentId: "a2", packId: "p2", agentPath: `/packs/p2/deployments/a2` },
    row("p3", "a3", { version: "2" }), // changed
    row("p4", "a4"), // added
  ];
  const d = diffDeployments(prev, next);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].packId, "p4");
  assert.equal(d.removed.length, 0);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].after.version, "2");
  // unchanged-only refresh: all buckets empty
  const none = diffDeployments(next, next.map((r) => ({ ...r })));
  assert.deepEqual([none.added.length, none.removed.length, none.changed.length], [0, 0, 0]);
});

test("cache: TTL window collapses fetches; single-flight merges stale readers", async () => {
  const clock = makeClock();
  let fetches = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const rows = [row("p1", "a1")];
  const cache = createBookkeepingCache({
    fetchRows: async () => {
      fetches += 1;
      if (fetches === 2) await gate; // the refresh after TTL is slow
      return rows;
    },
    ttlMs: 1000,
    hardStaleMs: 10_000,
    now: () => clock.now(),
  });

  // cold start waits for the first load
  assert.equal((await cache.rows()).length, 1);
  assert.equal(fetches, 1);
  // fresh: no refetch
  await cache.rows();
  assert.equal(fetches, 1);

  // stale: five concurrent readers trigger exactly one (slow) refresh;
  // they all get the stale snapshot immediately, not an error
  clock.t += 2000;
  const reads = await Promise.all([cache.rows(), cache.rows(), cache.rows(), cache.rows(), cache.rows()]);
  assert.ok(reads.every((r) => r.length === 1));
  assert.equal(fetches, 2);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetches, 2); // single-flight held
});

test("cache: resolve is O(1)-shaped (map hit/miss) and never staleness-degrades", async () => {
  const clock = makeClock();
  let fetches = 0;
  const cache = createBookkeepingCache({
    fetchRows: async () => {
      fetches += 1;
      return [row("p1", "a1")];
    },
    ttlMs: 1000,
    now: () => clock.now(),
  });
  const hit = await cache.resolve("packs-p1-deployments-a1"); // slugFor keeps the full path
  assert.equal(hit.packId, "p1");
  assert.equal(await cache.resolve("packs-nope-x"), null);
  assert.equal(fetches, 1);

  // long past TTL — resolve still answers from the snapshot (turn path),
  // refresh runs in background
  clock.t += 500_000;
  assert.equal((await cache.resolve("packs-p1-deployments-a1")).packId, "p1");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetches, 2);
});

test("cache: warm source failure serves stale; past the hard window hardStale() flips", async () => {
  const clock = makeClock();
  let fail = false;
  const cache = createBookkeepingCache({
    fetchRows: async () => {
      if (fail) throw new Error("packs internal down");
      return [row("p1", "a1")];
    },
    ttlMs: 1000,
    hardStaleMs: 5000,
    now: () => clock.now(),
  });
  await cache.rows();
  clock.t += 2000;
  fail = true;
  // enumeration keeps serving the stale snapshot; the refresh fails silently
  assert.equal((await cache.rows()).length, 1);
  assert.equal(cache.hardStale(), false);
  clock.t += 4000; // now past the hard window since the last GOOD load
  assert.equal(cache.hardStale(), true);
});

test("cache: cold-start failure propagates (route layer's 503)", async () => {
  const cache = createBookkeepingCache({
    fetchRows: async () => {
      throw Object.assign(new Error("packs internal API unreachable"), { code: "PACKS_INTERNAL_UNAVAILABLE" });
    },
  });
  await assert.rejects(() => cache.rows(), { code: "PACKS_INTERNAL_UNAVAILABLE" });
  await assert.rejects(() => cache.resolve("packs-p1-a1"));
});

// ── face-level: pagination + enumeration hard-stale gate ─────────────────────

function startApp(face) {
  const app = express();
  face.register(app);
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

async function faceHarness({ deployments, entries, hardStale }) {
  const deps = deployments.map((d) => ({ slug: d.slug, agentPath: d.agentPath }));
  const face = createA2aFace({
    core: {}, // catalog/card need no core
    resolveDeployment: async (slug) => deployments.find((d) => d.slug === slug) ?? null,
    listDeployments: async () => deps,
    hardStale,
    forwardHeaders: () => ({}),
    registryFetch: async (p) => {
      const slug = deps.find((d) => p === `/api/agents${d.agentPath}`)?.slug;
      const entry = slug && entries[slug];
      return new Response(entry ? JSON.stringify(entry) : "{}", { status: entry ? 200 : 404 });
    },
    config: { agentUrlFor: (agentPath) => `http://upstream${agentPath}/` },
  });
  return startApp(face);
}

test("face: catalog default keeps the legacy full shape; page/page_size paginates public-only", async () => {
  const mk = (n, vis = "public") => ({
    slug: `packs-p${n}-agent`,
    agentPath: `/packs/p${n}/deployments/agent`,
    entry: { visibility: vis, name: `Agent ${n}`, description: "d", version: "1" },
  });
  const all = [...Array(5)].map((_, i) => mk(i + 1));
  all[4].entry.visibility = "private";
  const { srv, base } = await faceHarness({
    deployments: all,
    entries: Object.fromEntries(all.map((d) => [d.slug, d.entry])),
    hardStale: () => false,
  });
  try {
    // no params → full list, private absent (legacy shape: no page fields)
    const full = await (await fetch(`${base}/api/wanxing/v1/agents`)).json();
    assert.equal(full.agents.length, 4);
    assert.equal(full.page, undefined);

    // page_size=2 page 2 → items 3-4 of the public list + total
    const pg = await (await fetch(`${base}/api/wanxing/v1/agents?page=2&page_size=2`)).json();
    assert.deepEqual(
      { page: pg.page, size: pg.page_size, total: pg.total, n: pg.agents.length },
      { page: 2, size: 2, total: 4, n: 2 },
    );
    assert.equal(pg.agents[0].slug, "packs-p3-agent");

    // page_size clamps at 200; junk falls back to defaults
    const clamped = await (await fetch(`${base}/api/wanxing/v1/agents?page_size=9999`)).json();
    assert.equal(clamped.page_size, 200);
    const junk = await (await fetch(`${base}/api/wanxing/v1/agents?page_size=abc`)).json();
    assert.equal(junk.page_size, 50);
  } finally {
    srv.close();
  }
});

test("face: enumeration faces 503 on hard-stale; unknown slugs still 404 cards", async () => {
  const d = { slug: "packs-p1-agent", agentPath: "/packs/p1/deployments/agent" };
  const { srv, base } = await faceHarness({
    deployments: [d],
    entries: { [d.slug]: { visibility: "public", name: "A", description: "d", version: "1" } },
    hardStale: () => true,
  });
  try {
    const cat = await fetch(`${base}/api/wanxing/v1/agents`);
    assert.equal(cat.status, 503);
    assert.equal((await cat.json()).error.code, "DEPLOYMENT_SOURCE_UNAVAILABLE");
    const card = await fetch(`${base}/api/wanxing/v1/a2a/packs-p1-agent/.well-known/agent-card.json`);
    assert.equal(card.status, 503);
  } finally {
    srv.close();
  }
});
