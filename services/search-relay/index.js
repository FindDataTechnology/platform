// ── Search relay (operator-side, zero-dependency single file) ────────────────
//
// Reference implementation of the /v1/search contract documented in the ops runbook
// ("Web search relay"). The platform's websearch MCP client is the only
// intended caller; this service fronts the gateway's websearch lane so no
// customer deployment ever holds an upstream credential.
//
//   POST /v1/search            Bearer <token: static keys.json/RELAY_TOKENS
//                              OR wsrc-<scope>-<mac> scoped token
//                              (scoped-token.js, add-mcp-credential-hygiene)>
//     {"query": "...", "num": 8}        → 200 {"results":[{title,url,snippet}]}
//   GET /healthz               → 200 {"ok":true}
//
// Behavior (the cost controls the platform relies on):
//   - Upstream = the 词元 (ciyuan) platform gateway websearch lane (called with
//     a dedicated internal key) — the ONLY supply. Provider keys (SerpAPI and
//     successors) live in the lane's account pool and nowhere else; this relay
//     is an admission + attribution layer on top. The direct provider path and
//     its `serpapi[]` cold standby were retired after a clean observation
//     window (retire-search-relay-direct): a lane outage surfaces as a clear
//     caller-visible error, never as a silent direct fallback.
//   - Lane breaker: a pure reachability signal for /v1/stats (3 consecutive
//     lane failures mark the lane unreachable for a window). It never gates
//     routing — the lane is the only path, so every request is a probe.
//   - BYOK (add-search-byok): a caller's X-Serpapi-Key rides the lane call
//     untouched; the lane implements prefer/fallback semantics and its
//     x-search-source (user/pool/pool-after-user-failure) comes back verbatim.
//   - Per-token daily caps (default 300) reset at UTC midnight.
//   - Identical (query, num) pairs are served from a 10-minute cache, capped
//     at 500 entries — demo traffic repeats itself heavily.
//   - Scoped tokens: wsrc-<scope-id>-<mac> verified against keys.json
//     `scoped_master` (stateless HMAC); `revoked_scopes` denies by scope.
//     Logs attribute scoped traffic by scope id, never by token value.
//
// Config: keys.json next to this file (gitignored) — {"tokens":[...],
// "scoped_master":"...", "revoked_scopes":[...],
// "ciyuan":{"url":"https://token.finddatatech.cloud","key":"sk-..."}}
// — or env RELAY_TOKENS / RELAY_SCOPED_MASTER / CIYUAN_URL+CIYUAN_KEY
// (comma-separated where lists; file wins). keys.json is hot-reloaded on mtime
// change (token/denylist/lane-key edits take effect without a restart; a
// reload also clears the breaker's reachability state, since an edit is an
// operator action).
// RELAY_KEYS_FILE overrides the keys.json path (tests/deployments).
// PORT (default 4597), RELAY_DAILY_CAP, RELAY_CACHE_TTL_SECS, RELAY_CACHE_MAX,
// RELAY_LANE_BREAKER_SECS.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTokenAuth, SCOPED_PREFIX } from "./scoped-token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// An EXPLICIT PORT (including "0" = ephemeral, the unit-test seam) is honored;
// only an unset/empty PORT falls back to 4597 — `Number("0") || 4597` would
// silently pin tests onto a possibly-occupied dev port.
const PORT = process.env.PORT !== undefined && process.env.PORT !== "" ? Number(process.env.PORT) : 4597;
const HOST = process.env.HOST || "127.0.0.1"; // loopback default; prod fronts it with a TLS proxy
const DAILY_CAP = Number(process.env.RELAY_DAILY_CAP) || 300;
const CACHE_TTL_MS = (Number(process.env.RELAY_CACHE_TTL_SECS) || 600) * 1000;
const CACHE_MAX = Number(process.env.RELAY_CACHE_MAX) || 500;
// Lane reachability window: after LANE_BREAKER_FAILS consecutive lane
// failures the lane reads as unreachable in /v1/stats for this long (a
// success at any point clears it). Routing is unaffected — see searchWithOverride.
const LANE_BREAKER_SECS = Number(process.env.RELAY_LANE_BREAKER_SECS) || 60;
const LANE_BREAKER_FAILS = 3;
const CIYUAN_TIMEOUT_MS = 20_000;

const KEYS_FILE = process.env.RELAY_KEYS_FILE || path.join(__dirname, "keys.json");

function loadKeys() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  } catch { /* no file — env only */ }
  const envList = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const ciyuanUrl = typeof file.ciyuan?.url === "string" && file.ciyuan.url
    ? file.ciyuan.url.trim().replace(/\/+$/, "")
    : (process.env.CIYUAN_URL || "").trim().replace(/\/+$/, "");
  const ciyuanKey = typeof file.ciyuan?.key === "string" && file.ciyuan.key
    ? file.ciyuan.key.trim()
    : (process.env.CIYUAN_KEY || "").trim();
  return {
    tokens: file.tokens?.length ? file.tokens : envList(process.env.RELAY_TOKENS),
    scopedMaster: typeof file.scoped_master === "string" && file.scoped_master
      ? file.scoped_master
      : (process.env.RELAY_SCOPED_MASTER || ""),
    revokedScopes: Array.isArray(file.revoked_scopes) ? file.revoked_scopes.map(String) : [],
    // Lane upstream (search-relay-via-ciyuan): both halves or nothing — a URL
    // without a key (or vice versa) is a misconfiguration, not a lane. Any
    // leftover `serpapi`/`glm` keys in the file are ignored: no direct path
    // exists to use them (retire-search-relay-direct).
    ciyuan: ciyuanUrl && ciyuanKey ? { url: ciyuanUrl, key: ciyuanKey } : null,
  };
}

// keys.json hot reload (denylist edits must take effect immediately — waiting
// for a rollout while a leaked scope is live defeats the revocation). mtimeMs
// compare per request: QPS here is capped by per-token daily quotas, so a
// stat() per request is noise. A transient stat failure keeps last-known.
let KEYS = loadKeys();
let keysMtimeMs = statKeysMtime();
function statKeysMtime() {
  try {
    return fs.statSync(KEYS_FILE).mtimeMs;
  } catch {
    return null;
  }
}
function reloadKeysIfStale() {
  const m = statKeysMtime();
  if (m === null || m === keysMtimeMs) return;
  keysMtimeMs = m;
  try {
    const next = loadKeys();
    // A file that drops the lane would leave nothing to serve — treat it like
    // any other unloadable file and keep last-known.
    if (!next.ciyuan) throw new Error("no `ciyuan` lane in the new file");
    KEYS = next;
    // An operator edit is a deliberate act (key rotation, revoke, re-point) —
    // drop any unreachable marking so the new configuration reads fresh.
    laneBreaker.fails = 0;
    laneBreaker.openUntil = 0;
    console.log(`[search-relay] keys reloaded: upstream=ciyuan-lane, ${next.tokens.length} static token(s), ${next.revokedScopes.length} revoked scope(s), scoped=${next.scopedMaster ? "on" : "off"}`);
  } catch (e) {
    console.error(`[search-relay] keys reload failed (${e?.message || e}); keeping last-known`);
  }
}

if (!KEYS.tokens.length && !KEYS.scopedMaster) {
  console.error("[search-relay] no credential material configured (keys.json `tokens`/`scoped_master` or RELAY_TOKENS/RELAY_SCOPED_MASTER) — refusing to start open");
  process.exit(1);
}
// The lane is the only supply (retire-search-relay-direct): without it there
// is nothing to serve, so refuse to start rather than 503 every request.
if (!KEYS.ciyuan) {
  console.error("[search-relay] no search upstream configured (keys.json `ciyuan` {url,key} or CIYUAN_URL+CIYUAN_KEY) — nothing to serve");
  process.exit(1);
}
console.log(`[search-relay] upstream=ciyuan-lane, ${KEYS.tokens.length} static token(s), scoped=${KEYS.scopedMaster ? "on" : "off"}, ${KEYS.revokedScopes.length} revoked scope(s), cap ${DAILY_CAP}/day`);

// ── stats counters (GET /v1/stats — the ops board's data source) ────────────
// Aggregates only, keyed by token PREFIX: never a token value, never the lane
// key. ops-console spec forbids secret material in stats.
const stats = {
  startedAt: Date.now(),
  cacheHits: 0,
  cacheMisses: 0,
  clientErrors: 0, // 4xx other than auth
  upstreamErrors: 0, // 5xx relay responses
  // Request-scoped override keys (add-search-byok) — counts only, no values;
  // attributed from the lane's x-search-source verdict.
  overrides: { used: 0, failed: 0, fallback: 0 },
  // Lane routing (search-relay-via-ciyuan): lane calls and lane failures.
  lane: { calls: 0, failures: 0 },
};

// ── lane reachability signal ─────────────────────────────────────────────────
// State machine: reachable → LANE_BREAKER_FAILS consecutive lane failures mark
// the lane unreachable for LANE_BREAKER_SECS; any success clears it. This is
// reporting only (stats `reachable`/`breakerOpen`): with no standby path the
// lane is always tried, so every request doubles as the probe.
const laneBreaker = { fails: 0, openUntil: 0 };
function laneBreakerOpen() {
  return Date.now() < laneBreaker.openUntil;
}
function laneFailure(err) {
  stats.lane.failures += 1;
  laneBreaker.fails += 1;
  if (laneBreaker.fails >= LANE_BREAKER_FAILS && !laneBreakerOpen()) {
    laneBreaker.openUntil = Date.now() + LANE_BREAKER_SECS * 1000;
    console.error(`[search-relay] lane breaker OPEN for ${LANE_BREAKER_SECS}s after ${laneBreaker.fails} consecutive failures (${err?.message || err})`);
  }
}
function laneSuccess() {
  laneBreaker.fails = 0;
  laneBreaker.openUntil = 0;
}
// A LANE request failure is anything that means "the lane did not answer a
// 2xx with a parseable envelope": transport/timeout, 5xx, and 401/403 (a bad
// or rotated internal key is an outage of this path, not of the request).
// 4xx shape errors from the lane (400/422) are NOT treated as outage signals —
// they propagate to the caller as relay errors.
function laneFailIsOutage(status) {
  return status === 0 || status >= 500 || status === 401 || status === 403;
}

// ── ciyuan lane upstream (search-relay-via-ciyuan D1-D3) ─────────────────────
// The lane's uniform envelope: {meta,results[],usage}; this relay's contract
// only carries `results` (title/url/snippet — same field names, position
// ignored). BYOK passthrough (D6): the caller's X-Serpapi-Key rides the lane
// call untouched; the lane implements prefer/fallback/label semantics and its
// x-search-source comes back verbatim.
async function ciyuanSearch(query, num, userKey) {
  stats.lane.calls += 1;
  const headers = {
    authorization: `Bearer ${KEYS.ciyuan.key}`,
    "content-type": "application/json",
  };
  if (userKey) headers["x-serpapi-key"] = userKey;
  let res;
  try {
    res = await fetch(`${KEYS.ciyuan.url}/v1/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ engine: "serpapi", q: query, num }),
      signal: AbortSignal.timeout(CIYUAN_TIMEOUT_MS),
    });
  } catch (err) {
    throw Object.assign(new Error(`lane unreachable: ${err?.message || err}`), { laneOutage: true, status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never leak the internal key; the lane's error text is safe to forward
    // as a message (it names lane-side conditions, not credentials).
    const message = data?.error?.message || data?.error || `lane HTTP ${res.status}`;
    throw Object.assign(new Error(typeof message === "string" ? message : `lane HTTP ${res.status}`), {
      laneOutage: laneFailIsOutage(res.status),
      status: res.status,
    });
  }
  return {
    results: Array.isArray(data.results)
      ? data.results.map((r) => ({ title: r.title || "", url: r.url || "", snippet: r.snippet || "" }))
      : [],
    laneSource: res.headers.get("x-search-source") || null,
  };
}

// ── per-token daily counters ─────────────────────────────────────────────────
const tokenDays = new Map(); // token -> { day: "YYYY-MM-DD", count }
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
function tokenTake(token) {
  const rec = tokenDays.get(token);
  const day = todayUtc();
  if (!rec || rec.day !== day) {
    tokenDays.set(token, { day, count: 1 });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}
function tokenCount(token) {
  const rec = tokenDays.get(token);
  return rec && rec.day === todayUtc() ? rec.count : 0;
}

// ── cache ────────────────────────────────────────────────────────────────────
const cache = new Map(); // "q\u0000num" -> { at, results }; insertion-ordered = LRU
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit); // refresh recency
  return hit.results;
}
function cacheSet(key, results) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { at: Date.now(), results });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ── BYOK attribution (add-search-byok, lane-side since search-relay-via-ciyuan D6)
// The caller's X-Serpapi-Key rides the lane call; the lane implements
// prefer/fallback and reports the verdict in x-search-source. Nothing about the
// override key is persisted or logged here — the relay never inspects it.
// Lane source header → the relay's caller-visible three states (D4).
function sourceFromLane(laneSource) {
  if (laneSource === "user") {
    stats.overrides.used += 1;
    return "user";
  }
  if (laneSource === "pool-after-user-failure") {
    stats.overrides.failed += 1;
    stats.overrides.fallback += 1;
    return "pool-after-user-failure";
  }
  // "pool", or a lane older than the header (served pool-side either way).
  return "pool";
}

// Top orchestrator: the lane is the only path. A lane outage is reported
// honestly to the caller (retire-search-relay-direct) and recorded in the
// reachability signal; lane 4xx shape errors propagate as the request's own.
// Returns { results, source, route }.
async function searchWithOverride(overrideKey, query, num) {
  try {
    const { results, laneSource } = await ciyuanSearch(query, num, overrideKey);
    laneSuccess();
    return { results, source: sourceFromLane(laneSource), route: "lane" };
  } catch (err) {
    if (!err.laneOutage) throw err;
    laneFailure(err);
    throw new Error(`search upstream unavailable (websearch lane): ${err.message}`);
  }
}

// ── server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const json = (status, body, extraHeaders) => {
    res.writeHead(status, { "content-type": "application/json", ...(extraHeaders || {}) });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/healthz") return json(200, { ok: true });

  reloadKeysIfStale();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const verdict = checkTokenAuth(token, {
    tokens: KEYS.tokens,
    scopedMaster: KEYS.scopedMaster,
    revokedScopes: KEYS.revokedScopes,
  });
  const tokenTag = verdict.tag;
  if (!verdict.ok) {
    console.error(`[search-relay] 401 token=${tokenTag} reason=${verdict.reason}`);
    return json(401, { error: "invalid token" });
  }

  // Read-only aggregates for the ops board. Secret-free by construction:
  // token prefixes and scope ids only — never a token value (spec:
  // ops-console, stats scenario).
  if (req.method === "GET" && req.url === "/v1/stats") {
    const day = todayUtc();
    // Scoped-token usage, aggregated by scope id (the attribution marker).
    const scopeCounts = new Map();
    for (const [tok, rec] of tokenDays) {
      if (!tok.startsWith(SCOPED_PREFIX) || rec.day !== day) continue;
      const scope = tok.slice(SCOPED_PREFIX.length, tok.lastIndexOf("-"));
      scopeCounts.set(scope, Math.max(scopeCounts.get(scope) || 0, rec.count));
    }
    return json(200, {
      day,
      dailyCap: DAILY_CAP,
      tokens: KEYS.tokens.map((t) => {
        const rec = tokenDays.get(t);
        return { prefix: `${t.slice(0, 6)}…`, count: rec && rec.day === day ? rec.count : 0 };
      }),
      scopes: [...scopeCounts.entries()].map(([scope, count]) => ({ scope, count })),
      cache: {
        hits: stats.cacheHits,
        misses: stats.cacheMisses,
        hitRate: stats.cacheHits + stats.cacheMisses > 0
          ? Number((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)).toFixed(3))
          : null,
        entries: cache.size,
      },
      // Upstream: the lane is the only supply (retire-search-relay-direct) —
      // mode is constant, reachable/breakerOpen are the reachability signal.
      upstream: {
        mode: "ciyuan",
        laneConfigured: true,
        reachable: !laneBreakerOpen(),
        breakerOpen: laneBreakerOpen(),
        laneCalls: stats.lane.calls,
        laneFailures: stats.lane.failures,
      },
      // Request-scoped user keys (add-search-byok): counts only, never values.
      overrides: { ...stats.overrides },
      errors: {
        client: stats.clientErrors,
        upstream: stats.upstreamErrors,
      },
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
    });
  }

  if (req.method !== "POST" || !req.url.startsWith("/v1/search")) return json(404, { error: "not found" });

  // Request-scoped upstream key override (add-search-byok): an optional
  // caller-supplied SerpAPI key. Absent header = byte-identical behavior.
  const overrideKey = (req.headers["x-serpapi-key"] || "").trim() || null;

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const started = Date.now();
    const jsonSrc = (status, payload, source) =>
      json(status, payload, source ? { "x-search-source": source } : undefined);
    try {
      const { query, num: rawNum } = JSON.parse(body || "{}");
      if (typeof query !== "string" || !query.trim()) {
        stats.clientErrors += 1;
        return jsonSrc(400, { error: "missing query" });
      }
      const num = Math.min(10, Math.max(1, Math.floor(Number(rawNum) || 8)));

      if (tokenCount(token) >= DAILY_CAP) {
        stats.clientErrors += 1;
        return jsonSrc(429, { error: `daily cap (${DAILY_CAP}) reached for this token` });
      }

      const cacheKey = `${query.trim().toLowerCase()}\u0000${num}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        stats.cacheHits += 1;
        console.log(`[search-relay] 200 token=${tokenTag} cache=hit ${Date.now() - started}ms`);
        // Serve the SOURCE of the original fetch so attribution stays honest.
        return jsonSrc(200, { results: cached.results }, cached.source);
      }
      stats.cacheMisses += 1;

      const { results, source, route } = await searchWithOverride(overrideKey, query.trim(), num);
      cacheSet(cacheKey, { results, source });
      tokenTake(token);
      console.log(`[search-relay] 200 token=${tokenTag} source=${source} route=${route} cache=miss ${results.length}r ${Date.now() - started}ms`);
      jsonSrc(200, { results }, source);
    } catch (err) {
      stats.upstreamErrors += 1;
      console.error(`[search-relay] 503 token=${tokenTag} ${err.message}`);
      jsonSrc(503, { error: err.message });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[search-relay] listening on ${HOST}:${PORT}`);
});

// Test seam only: importing this file runs the server (it is a script); the
// export lets unit tests discover the bound port (PORT=0 → ephemeral).
export const relayServer = server;
