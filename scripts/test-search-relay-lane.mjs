// Lane upstream for the search relay (search-relay-via-ciyuan §1).
//
// The relay's shared pool is served by the 词元 platform gateway websearch lane
// (keys.json `ciyuan:{url,key}`); the direct SerpAPI path is cold standby.
// Lanes here (one live relay, ephemeral port, both upstreams stubbed):
//   1. lane happy path — internal key on the wire, envelope unwrap, BYOK
//      passthrough header, x-search-source passthrough (three states).
//   2. breaker — 3 consecutive lane failures open a 60s (test: 1s) window:
//      requests route direct WITHOUT touching the lane; the first request
//      after the window probes the lane and a success closes the breaker.
//   3. keys.json reload clears an open breaker (operator edit = try again).
//   4. stats — upstream {mode,laneConfigured,reachable,breakerOpen,…} shape;
//      dual-path failure 503 naming both.
//
// Run: node scripts/test-search-relay-lane.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const tmp = mkdtempSync(join(tmpdir(), "search-relay-lane-test-"));
const keysFile = join(tmp, "keys.json");
const STATIC = "lane-static-token";
const LANE_KEY = "sk-lane-internal-123";
const LANE_URL = "https://ciyuan.unit.test";
const STANDBY_KEY = "standby-key-1";

writeFileSync(keysFile, JSON.stringify({
  ciyuan: { url: LANE_URL, key: LANE_KEY },
  serpapi: [STANDBY_KEY],
  tokens: [STATIC],
}));

// Upstream stub. The lane and serpapi.com have distinct scripted behaviors:
//   lane: { mode: "ok" | "http500" | "unreachable", source: "pool"|"user"|… }
//   serpapi: { mode: "ok" | "fail" }
const realFetch = globalThis.fetch;
let lane = { mode: "ok", source: "pool" };
let serpapi = { mode: "ok" };
const laneCalls = []; // captured per-call headers
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith(LANE_URL)) {
    laneCalls.push({ headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts?.body || "{}") });
    if (lane.mode === "unreachable") throw new Error("ECONNREFUSED (stub)");
    if (lane.mode === "http500") {
      return new Response(JSON.stringify({ error: { message: "lane exploded" } }), { status: 500 });
    }
    return new Response(JSON.stringify({
      meta: { engine: "serpapi", latency_ms: 12 },
      results: [{ title: "lane", url: "https://lane.test", snippet: "s", position: 1 }],
      usage: { requests: 1 },
    }), { status: 200, headers: { "content-type": "application/json", ...(lane.source ? { "x-search-source": lane.source } : {}) } });
  }
  if (u.includes("serpapi.com")) {
    const key = new URL(u).searchParams.get("api_key");
    if (key !== STANDBY_KEY || serpapi.mode === "fail") {
      return new Response(JSON.stringify({ error: "account has run out of searches" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ organic_results: [{ title: "standby", link: "https://standby.test", snippet: "s" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(url, opts);
};

process.env.RELAY_KEYS_FILE = keysFile;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.RELAY_LANE_BREAKER_SECS = "1"; // window is configurable; 1s keeps the probe fast
const relay = await import("../services/search-relay/index.js");
if (!relay.relayServer.listening) await once(relay.relayServer, "listening");
const base = `http://127.0.0.1:${relay.relayServer.address().port}`;

let qn = 0;
function search(headers = {}) {
  qn += 1;
  return realFetch(`${base}/v1/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${STATIC}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ query: `lane-${qn}`, num: 2 }),
  });
}
async function stats() {
  return (await realFetch(`${base}/v1/stats`, { headers: { authorization: `Bearer ${STATIC}` } })).json();
}

test("lane happy path: internal key on the wire, envelope unwrapped, source passed through", async () => {
  lane = { mode: "ok", source: "pool" };
  laneCalls.length = 0;
  const res = await search();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-search-source"), "pool");
  const body = await res.json();
  assert.deepEqual(body.results, [{ title: "lane", url: "https://lane.test", snippet: "s" }], "envelope unwrapped to the relay contract (position dropped)");
  assert.equal(laneCalls.length, 1, "lane was the only upstream touched");
  assert.equal(laneCalls[0].headers.authorization, `Bearer ${LANE_KEY}`, "relay authenticates with the internal lane key");
  assert.equal(laneCalls[0].headers["x-serpapi-key"], undefined, "no override header when the caller brought none");
  assert.equal(laneCalls[0].body.engine, "serpapi");
  assert.equal(laneCalls[0].body.num, 2);
});

test("BYOK passthrough: caller's X-Serpapi-Key rides the lane call; lane source comes back verbatim", async () => {
  lane = { mode: "ok", source: "user" };
  laneCalls.length = 0;
  let res = await search({ "x-serpapi-key": "user-owned-key" });
  assert.equal(res.headers.get("x-search-source"), "user");
  assert.equal(laneCalls[0].headers["x-serpapi-key"], "user-owned-key", "override forwards, relay does not pre-judge it");

  lane = { mode: "ok", source: "pool-after-user-failure" };
  laneCalls.length = 0;
  res = await search({ "x-serpapi-key": "user-owned-key-bad" });
  assert.equal(res.headers.get("x-search-source"), "pool-after-user-failure", "lane's fallback verdict is what the caller sees");

  const s = await stats();
  assert.ok(s.overrides.used >= 1 && s.overrides.failed >= 1, "lane-attributed overrides counted");
  assert.ok(!JSON.stringify(s).includes("user-owned-key"), "no key values in stats");
  lane = { mode: "ok", source: "pool" };
});

test("breaker: 3 consecutive lane failures open the window; requests skip the lane and serve direct", async () => {
  lane = { mode: "http500", source: "pool" };
  for (let i = 0; i < 3; i++) {
    const res = await search();
    assert.equal(res.status, 200, "cold standby covers the failing lane");
    assert.equal(res.headers.get("x-search-source"), "pool");
    const body = await res.json();
    assert.equal(body.results[0].title, "standby", "served by the direct path");
  }
  let s = await stats();
  assert.equal(s.upstream.mode, "ciyuan");
  assert.equal(s.upstream.laneConfigured, true);
  assert.equal(s.upstream.breakerOpen, true, "3 failures opened the breaker");
  assert.equal(s.upstream.reachable, false);
  assert.ok(s.upstream.fallbacks >= 3, "each fallback counted");

  // Window open: requests do NOT touch the lane at all.
  laneCalls.length = 0;
  const res = await search();
  assert.equal(res.status, 200);
  assert.equal(laneCalls.length, 0, "lane skipped while the breaker is open");
  s = await stats();
  assert.ok(s.upstream.fallbacks >= 4);

  // Window passes → next request probes the lane; success closes the breaker.
  await new Promise((r) => setTimeout(r, 1100));
  lane = { mode: "ok", source: "pool" };
  laneCalls.length = 0;
  const probe = await search();
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).results[0].title, "lane", "recovered lane served again");
  assert.equal(laneCalls.length, 1, "post-window request probed the lane");
  s = await stats();
  assert.equal(s.upstream.breakerOpen, false, "success closed the breaker");
  assert.equal(s.upstream.reachable, true);
});

test("keys.json reload clears an open breaker (operator edit = trust the new config)", async () => {
  lane = { mode: "http500", source: "pool" };
  for (let i = 0; i < 3; i++) await search();
  assert.equal((await stats()).upstream.breakerOpen, true);

  // Edit keys.json (same content is fine — the mtime change is the signal).
  writeFileSync(keysFile, JSON.stringify({ ciyuan: { url: LANE_URL, key: LANE_KEY }, serpapi: [STANDBY_KEY], tokens: [STATIC] }));
  const future = new Date(Date.now() + 5000);
  utimesSync(keysFile, future, future);

  lane = { mode: "ok", source: "pool" };
  laneCalls.length = 0;
  const res = await search();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).results[0].title, "lane", "reload cleared the breaker; lane tried again immediately");
  assert.equal(laneCalls.length, 1);
  assert.equal((await stats()).upstream.breakerOpen, false);
});

test("dual-path failure: lane down (no standby) 503 names the lane", async () => {
  // Reconfigure to lane-only by wiping the standby array via reload.
  writeFileSync(keysFile, JSON.stringify({ ciyuan: { url: LANE_URL, key: LANE_KEY }, serpapi: [], tokens: [STATIC] }));
  const future = new Date(Date.now() + 6000);
  utimesSync(keysFile, future, future);
  lane = { mode: "unreachable", source: "pool" };
  const res = await search();
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /lane unavailable/, "names the lane failure");
  assert.match(body.error, /no cold standby configured/);

  // Both configured, both down → the message names both paths.
  writeFileSync(keysFile, JSON.stringify({ ciyuan: { url: LANE_URL, key: LANE_KEY }, serpapi: [STANDBY_KEY], tokens: [STATIC] }));
  utimesSync(keysFile, new Date(Date.now() + 7000), new Date(Date.now() + 7000));
  serpapi = { mode: "fail" };
  const res2 = await search();
  assert.equal(res2.status, 503);
  const body2 = await res2.json();
  assert.match(body2.error, /lane unavailable and cold standby exhausted/);
  lane = { mode: "ok", source: "pool" };
  serpapi = { mode: "ok" };
});

test.after(() => {
  relay.relayServer.close();
  globalThis.fetch = realFetch;
  delete process.env.RELAY_KEYS_FILE;
  delete process.env.RELAY_LANE_BREAKER_SECS;
  rmSync(tmp, { recursive: true, force: true });
});
