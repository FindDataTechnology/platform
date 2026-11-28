// Unit tests for the web list-cache core (openspec: polish-web-surfaces, task
// 1.1). The repo has no browser-side unit runner, so — like test-qr-svg.mjs —
// the framework-free core is imported under plain node (type stripping) and the
// React binding's DOM behavior is covered by e2e. Runs under `npm run test:unit`.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __listCacheSubscriberCount,
  listCacheClear,
  listCacheGet,
  listCacheHas,
  listCacheInvalidate,
  listCacheSet,
  listCacheSubscribe,
} from "../web/src/lib/listCache.ts";

test("cold key has no cached value", () => {
  listCacheClear();
  assert.equal(listCacheHas("catalog"), false);
  assert.equal(listCacheGet("catalog"), undefined);
});


test("background revalidation failure keeps last-known-good (no blank-out)", () => {
  // The hook contract (hooks/useListCache.ts load()): on fetch error the status
  // stays "loaded" whenever a cached payload exists, and `data` is never reset
  // to null. Pin the source so a refactor cannot silently blank cached surfaces.
  const src = readFileSync(new URL("../web/src/hooks/useListCache.ts", import.meta.url), "utf8");
  assert.match(src, /setStatus\(listCacheGet\(key\) !== undefined \? "loaded" : "error"\)/, "error path must keep cached surfaces loaded");
  assert.doesNotMatch(src, /listCacheSet\(key,\s*null/, "error path must never null the cache");
});
test("round-trips a payload", () => {
  listCacheClear();
  listCacheSet("catalog", { agents: ["a"], apps: ["b"] });
  assert.equal(listCacheHas("catalog"), true);
  assert.deepEqual(listCacheGet("catalog"), { agents: ["a"], apps: ["b"] });
});

test("invalidate drops the exact key and informs its subscriber", () => {
  listCacheClear();
  listCacheSet("fleets", [1, 2, 3]);
  let hits = 0;
  const off = listCacheSubscribe("fleets", () => {
    hits += 1;
  });
  listCacheInvalidate("fleets");
  assert.equal(listCacheHas("fleets"), false);
  assert.equal(hits, 1);
  off();
});

test("invalidate by prefix drops children and spares siblings", () => {
  listCacheClear();
  listCacheSet("catalog", 1);
  listCacheSet("catalog:agents", 2);
  listCacheSet("connections", 3);
  const dropped = listCacheInvalidate("catalog");
  assert.equal(dropped, 2);
  assert.equal(listCacheHas("catalog"), false);
  assert.equal(listCacheHas("catalog:agents"), false);
  assert.equal(listCacheHas("connections"), true);
});

test("invalidate notifies only matching subscribers", () => {
  listCacheClear();
  listCacheSet("catalog:agents", 1);
  listCacheSet("fleets", 2);
  let catalogHits = 0;
  let fleetHits = 0;
  const offA = listCacheSubscribe("catalog:agents", () => {
    catalogHits += 1;
  });
  const offB = listCacheSubscribe("fleets", () => {
    fleetHits += 1;
  });
  listCacheInvalidate("catalog");
  assert.equal(catalogHits, 1);
  assert.equal(fleetHits, 0);
  offA();
  offB();
});

test("clear empties everything and informs all subscribers", () => {
  listCacheClear();
  listCacheSet("a", 1);
  listCacheSet("b", 2);
  let hits = 0;
  const off = listCacheSubscribe("a", () => {
    hits += 1;
  });
  listCacheClear();
  assert.equal(listCacheHas("a"), false);
  assert.equal(listCacheHas("b"), false);
  assert.equal(hits, 1);
  off();
});

test("unsubscribe stops notifications", () => {
  listCacheClear();
  listCacheSet("catalog", 1);
  let hits = 0;
  const off = listCacheSubscribe("catalog", () => {
    hits += 1;
  });
  off();
  assert.equal(__listCacheSubscriberCount(), 0);
  listCacheInvalidate("catalog");
  assert.equal(hits, 0);
});

test("the store is bounded, evicting the least-recently-written entry", () => {
  listCacheClear();
  for (let i = 0; i < 60; i += 1) listCacheSet(`k${i}`, i);
  // 50-cap: the first ten writes are gone, the last fifty survive.
  assert.equal(listCacheHas("k0"), false);
  assert.equal(listCacheHas("k9"), false);
  assert.equal(listCacheHas("k10"), true);
  assert.equal(listCacheHas("k59"), true);
  // Re-writing refreshes order: k10 becomes newest, so the next overflow evicts k11.
  listCacheSet("k10", 10);
  listCacheSet("k60", 60);
  assert.equal(listCacheHas("k11"), false);
  assert.equal(listCacheHas("k10"), true);
  listCacheClear();
});

// app-center-load-recovery D2: coldRetry is opt-in, deduped, and the error
// state is reserved for the exhausted attempt. No browser unit runner exists
// for the hook, so — same house style as the blank-out pin above — the
// contract is pinned at the source and exercised end-to-end in e2e.
test("coldRetry: opt-in budget keeps the loading frame until it is spent", () => {
  const src = readFileSync(new URL("../web/src/hooks/useListCache.ts", import.meta.url), "utf8");
  // default 0: callers that pass nothing keep the pre-change behavior exactly
  assert.match(src, /optionsRef\.current\.coldRetry \?\? 0/, "coldRetry must default to 0");
  // a cold failure WITH budget left returns early — no setStatus("error") on
  // that path; the skeleton owns the frame until the backoff attempt lands
  assert.match(src, /listCacheGet\(key\) === undefined && coldUsed\.current < budget/, "cold retry gate");
  // one fetch in flight per key: focus revalidation and the cold backoff must
  // not double-fetch
  assert.match(src, /if \(inFlight\.current\) return inFlight\.current/, "in-flight dedupe");
  // the terminal path (budget spent) still goes through the cached-or-error line
  assert.match(src, /setStatus\(listCacheGet\(key\) !== undefined \? "loaded" : "error"\)/);
});

test("coldRetry: only the app-center catalog read opts in", () => {
  const src = readFileSync(new URL("../web/src/pages/AppCenterPage.tsx", import.meta.url), "utf8");
  assert.match(src, /useListCache\("catalog", fetchCatalog, \{ coldRetry: 1 \}\)/, "catalog opts in once");
  // connections stays silent-by-design (app-center spec: badge failure hides
  // badges, never an error frame)
  assert.match(src, /useListCache\("connections", fetchConnectionStates\)/, "connections keeps default posture");
});
