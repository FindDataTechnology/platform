// Lane upstream for the search relay (search-relay-via-ciyuan §1, direct path
// retired by retire-search-relay-direct).
//
// The relay's shared pool is served by the 词元 platform gateway websearch lane
// (keys.json `ciyuan:{url,key}`) — the only supply. Lanes here (one live relay,
// ephemeral port, upstream stubbed):
//   1. lane happy path — internal key on the wire, envelope unwrap, BYOK
//      passthrough header, x-search-source passthrough (three states).
//   2. reachability signal — 3 consecutive lane failures mark the lane
//      unreachable in stats for a window (test: 1s); every request is still
//      routed to the lane (nothing to fall back to) and answered with a clear
//      503; the next success clears the signal.
//   3. keys.json reload clears the signal (operator edit = try again).
//   4. no direct path exists: a leftover `serpapi[]` in keys.json never
//      causes a serpapi.com call; stats carry no cold-standby fields.
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

writeFileSync(keysFile, JSON.stringify({
  ciyuan: { url: LANE_URL, key: LANE_KEY },
  tokens: [STATIC],
}));

// Upstream stub. lane: { mode: "ok" | "http500" | "unreachable", source }.
// Any serpapi.com call is a test failure — the direct path no longer exists.
const realFetch = globalThis.fetch;
let lane = { mode: "ok", source: "pool" };
const laneCalls = []; // captured per-call headers
let serpapiCalls = 0;
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
    serpapiCalls += 1;
    return new Response(JSON.stringify({ organic_results: [{ title: "DIRECT", link: "https://direct.test", snippet: "s" }] }), { status: 200 });
  }
  return realFetch(url, opts);
};

process.env.RELAY_KEYS_FILE = keysFile;
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.RELAY_LANE_BREAKER_SECS = "1"; // window is configurable; 1s keeps the test fast
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

test("reachability signal: 3 lane failures mark it unreachable; every request still goes to the lane and gets a clear 503", async () => {
  lane = { mode: "http500", source: "pool" };
  laneCalls.length = 0;
  for (let i = 0; i < 3; i++) {
    const res = await search();
    assert.equal(res.status, 503, "no standby: a lane failure is the caller's answer");
    assert.equal(res.headers.get("x-search-source"), null, "no source header on an error");
    const body = await res.json();
    assert.match(body.error, /search upstream unavailable \(websearch lane\)/, "names the lane as the failing upstream");
    assert.match(body.error, /lane exploded/, "carries the lane's own message");
  }
  assert.equal(laneCalls.length, 3, "each request went to the lane");
  let s = await stats();
  assert.equal(s.upstream.mode, "ciyuan");
  assert.equal(s.upstream.laneConfigured, true);
  assert.equal(s.upstream.breakerOpen, true, "3 failures raised the signal");
  assert.equal(s.upstream.reachable, false);
  assert.ok(s.upstream.laneFailures >= 3, "each failure counted");
  assert.equal(s.upstream.fallbacks, undefined, "no cold-standby counter remains");

  // Signal raised: the lane is STILL the route (nothing else to try), so the
  // request probes it immediately rather than waiting for a window.
  laneCalls.length = 0;
  lane = { mode: "ok", source: "pool" };
  const probe = await search();
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).results[0].title, "lane", "recovered lane served again");
  assert.equal(laneCalls.length, 1, "request went to the lane while the signal was raised");
  s = await stats();
  assert.equal(s.upstream.breakerOpen, false, "success cleared the signal");
  assert.equal(s.upstream.reachable, true);
});

test("keys.json reload clears the reachability signal (operator edit = trust the new config)", async () => {
  lane = { mode: "http500", source: "pool" };
  for (let i = 0; i < 3; i++) await search();
  assert.equal((await stats()).upstream.breakerOpen, true);

  // Edit keys.json (same content is fine — the mtime change is the signal).
  writeFileSync(keysFile, JSON.stringify({ ciyuan: { url: LANE_URL, key: LANE_KEY }, tokens: [STATIC] }));
  const future = new Date(Date.now() + 5000);
  utimesSync(keysFile, future, future);

  // The reload alone clears the signal — observable before any lane call.
  lane = { mode: "ok", source: "pool" };
  assert.equal((await stats()).upstream.breakerOpen, false, "reload cleared the signal");
  const res = await search();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).results[0].title, "lane");
});

test("no direct path: leftover serpapi[] in keys.json is inert; lane outage 503 names the lane; stats carry no standby fields", async () => {
  writeFileSync(keysFile, JSON.stringify({ ciyuan: { url: LANE_URL, key: LANE_KEY }, serpapi: ["leftover-key"], tokens: [STATIC] }));
  const future = new Date(Date.now() + 6000);
  utimesSync(keysFile, future, future);
  lane = { mode: "unreachable", source: "pool" };
  serpapiCalls = 0;
  const res = await search();
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /search upstream unavailable \(websearch lane\)/);
  assert.match(body.error, /lane unreachable/, "names the lane failure");
  assert.equal(serpapiCalls, 0, "serpapi.com was never called — no direct path exists");

  const s = await stats();
  assert.equal(s.keys, undefined, "no per-key cold-standby view in stats");
  assert.equal(s.upstream.fallbacks, undefined);
  assert.equal(s.errors.poolDry, undefined);
  assert.ok(!JSON.stringify(s).includes("leftover-key"), "no key values in stats");
  lane = { mode: "ok", source: "pool" };
});

test("reload that drops the lane keeps last-known config (nothing else could serve)", async () => {
  writeFileSync(keysFile, JSON.stringify({ tokens: [STATIC] }));
  const future = new Date(Date.now() + 7000);
  utimesSync(keysFile, future, future);
  lane = { mode: "ok", source: "pool" };
  laneCalls.length = 0;
  const res = await search();
  assert.equal(res.status, 200, "still served by the last-known lane");
  assert.equal(laneCalls[0].headers.authorization, `Bearer ${LANE_KEY}`);
});

test.after(() => {
  relay.relayServer.close();
  globalThis.fetch = realFetch;
  delete process.env.RELAY_KEYS_FILE;
  delete process.env.RELAY_LANE_BREAKER_SECS;
  rmSync(tmp, { recursive: true, force: true });
});
