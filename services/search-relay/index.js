// ── Search relay (operator-side, zero-dependency single file) ────────────────
//
// Reference implementation of the /v1/search contract documented in the ops runbook
// ("Web search relay"). The platform's websearch MCP client is the only
// intended caller; this service pools provider keys so no customer deployment
// ever holds one.
//
//   POST /v1/search            Bearer <token: static keys.json/RELAY_TOKENS
//                              OR wsrc-<scope>-<mac> scoped token
//                              (scoped-token.js, add-mcp-credential-hygiene)>
//     {"query": "...", "num": 8}        → 200 {"results":[{title,url,snippet}]}
//   GET /healthz               → 200 {"ok":true}
//
// Behavior (the cost controls the platform relies on):
//   - Upstream = the 词元 (ciyuan) platform gateway websearch lane (called with
//     a dedicated internal key). Provider keys (SerpAPI and successors) live in
//     the lane's account pool and nowhere else; this relay is an admission +
//     attribution layer on top.
//   - Cold standby: a DIRECT SerpAPI path (keys.json `serpapi[]`) covers lane
//     outages — a lane error falls back per request, and 3 consecutive lane
//     failures open a 60s breaker during which requests skip the lane; the
//     first request after the window probes it again. Standby usage is counted
//     and reported (`upstream.fallbacks`), never silent.
//   - SerpAPI key pool with round-robin; a key that errors (quota/auth/rate)
//     goes into a cooldown and the next key is tried. All keys dry ⇒ 503.
//   - GLM fallback: reserved in keys.json (glm: []) but NOT implemented yet —
//     wire it when a GLM search key arrives; until then an exhausted pool is
//     an honest 503 rather than guessed-at integration code.
//   - Per-token daily caps (default 300) reset at UTC midnight.
//   - Identical (query, num) pairs are served from a 10-minute cache, capped
//     at 500 entries — demo traffic repeats itself heavily.
//   - Scoped tokens: wsrc-<scope-id>-<mac> verified against keys.json
//     `scoped_master` (stateless HMAC); `revoked_scopes` denies by scope.
//     Logs attribute scoped traffic by scope id, never by token value.
//
// Config: keys.json next to this file (gitignored) — {"serpapi":[...],
// "glm":[...], "tokens":[...], "scoped_master":"...", "revoked_scopes":[...],
// "ciyuan":{"url":"https://token.finddatatech.cloud","key":"sk-..."}}
// — or env SERPAPI_KEYS / GLM_KEYS / RELAY_TOKENS / RELAY_SCOPED_MASTER /
// CIYUAN_URL+CIYUAN_KEY (comma-separated where lists; file wins). keys.json is
// hot-reloaded on mtime change (tokens/denylist edits take effect without a
// restart; a reload also closes any open lane breaker, since an edit is an
// operator action).
// RELAY_KEYS_FILE overrides the keys.json path (tests/deployments).
// PORT (default 4597), RELAY_DAILY_CAP, RELAY_CACHE_TTL_SECS, RELAY_CACHE_MAX,
// RELAY_LANE_BREAKER_SECS.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
const KEY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
// Cold-standby breaker (search-relay-via-ciyuan D5): lane failures open a
// window during which requests go straight to the direct path (saving the
// extra hop); the first request after it probes the lane again.
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
    serpapi: file.serpapi?.length ? file.serpapi : envList(process.env.SERPAPI_KEYS),
    glm: file.glm?.length ? file.glm : envList(process.env.GLM_KEYS),
    tokens: file.tokens?.length ? file.tokens : envList(process.env.RELAY_TOKENS),
    scopedMaster: typeof file.scoped_master === "string" && file.scoped_master
      ? file.scoped_master
      : (process.env.RELAY_SCOPED_MASTER || ""),
    revokedScopes: Array.isArray(file.revoked_scopes) ? file.revoked_scopes.map(String) : [],
    // Lane upstream (search-relay-via-ciyuan): both halves or nothing — a URL
    // without a key (or vice versa) is a misconfiguration, not a lane.
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
    KEYS = next;
    stats.keyFailures.length = 0;
    for (let i = 0; i < next.serpapi.length; i++) stats.keyFailures[i] = stats.keyFailures[i] ?? 0;
    // An operator edit is a deliberate act (key rotation, revoke, re-point) —
    // drop any open lane breaker so the new configuration is tried immediately.
    laneBreaker.fails = 0;
    laneBreaker.openUntil = 0;
    console.log(`[search-relay] keys reloaded: ${next.serpapi.length} serpapi key(s), upstream=${next.ciyuan ? "ciyuan-lane" : "direct"}, ${next.tokens.length} static token(s), ${next.revokedScopes.length} revoked scope(s), scoped=${next.scopedMaster ? "on" : "off"}`);
  } catch (e) {
    console.error(`[search-relay] keys reload failed (${e?.message || e}); keeping last-known`);
  }
}

if (!KEYS.tokens.length && !KEYS.scopedMaster) {
  console.error("[search-relay] no credential material configured (keys.json `tokens`/`scoped_master` or RELAY_TOKENS/RELAY_SCOPED_MASTER) — refusing to start open");
  process.exit(1);
}
// A serving upstream is required: the lane, the direct standby, or both.
// Direct-only remains a fully supported shape (the lane is an upgrade, not a
// hard dependency) — that pairing is also the rollback state.
if (!KEYS.ciyuan && !KEYS.serpapi.length) {
  console.error("[search-relay] no search upstream configured (keys.json `ciyuan`/CIYUAN_URL+CIYUAN_KEY, or `serpapi`/SERPAPI_KEYS) — nothing to serve");
  process.exit(1);
}
console.log(`[search-relay] upstream=${KEYS.ciyuan ? "ciyuan-lane" : "direct"}${KEYS.ciyuan && !KEYS.serpapi.length ? " (no cold standby configured)" : ""}, ${KEYS.serpapi.length} standby serpapi key(s), ${KEYS.glm.length} glm key(s) (fallback: not wired), ${KEYS.tokens.length} static token(s), scoped=${KEYS.scopedMaster ? "on" : "off"}, ${KEYS.revokedScopes.length} revoked scope(s), cap ${DAILY_CAP}/day`);

// ── stats counters (GET /v1/stats — the ops board's data source) ────────────
// Aggregates only, keyed by token PREFIX and key INDEX: never a token value,
// never a provider key. ops-console spec forbids secret material in stats.
const stats = {
  startedAt: Date.now(),
  cacheHits: 0,
  cacheMisses: 0,
  clientErrors: 0, // 4xx other than auth
  upstreamErrors: 0, // 5xx relay responses
  poolDry: 0, // all keys exhausted/cooling
  keyFailures: KEYS.serpapi.map(() => 0), // by pool index
  // Request-scoped override keys (add-search-byok) — counts only, no values.
  overrides: { used: 0, failed: 0, fallback: 0 },
  // Lane routing (search-relay-via-ciyuan): lane calls, lane failures, and
  // how many requests the cold-standby direct path ultimately served.
  lane: { calls: 0, failures: 0, fallbacks: 0 },
};

// ── lane breaker (search-relay-via-ciyuan D5) ────────────────────────────────
// State machine: closed (lane is primary) → 3 consecutive lane failures open a
// window (direct path serves, lane skipped) → first request after the window
// probes the lane; success closes the breaker, failure re-opens it.
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

// ── SerpAPI pool ─────────────────────────────────────────────────────────────
const keyCooldown = new Map(); // key -> until-ts
let rrIndex = 0;
async function serpapiSearch(key, query, num) {
  const url =
    `https://serpapi.com/search.json?engine=google_light` +
    `&q=${encodeURIComponent(query)}&num=${num}&api_key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  const data = await res.json().catch(() => ({}));
  // A zero-result query is a valid outcome, not a key failure — returning it
  // as an error would cool the key down and (on a one-key pool) 503 the pool
  // for a minute over nothing.
  if (/hasn't returned any results/i.test(String(data.error || ""))) return [];
  if (!res.ok || data.error) {
    throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  }
  // SerpAI ignores `num` more often than not — slice ourselves.
  return (data.organic_results || []).slice(0, num).map((r) => ({
    title: r.title || "",
    url: r.link || "",
    snippet: r.snippet || "",
  }));
}
// Exhausting vs transient is a property of the FAILURE, shared by pool keys
// and request-scoped override keys.
function isExhausting(err) {
  return /run out of searches|account|api key|unauthorized|401|429/i.test(String(err.message) + String(err.status));
}
async function poolSearch(query, num) {
  const now = Date.now();
  for (let attempt = 0; attempt < KEYS.serpapi.length; attempt++) {
    const key = KEYS.serpapi[rrIndex];
    rrIndex = (rrIndex + 1) % KEYS.serpapi.length;
    const cooldownUntil = keyCooldown.get(key) || 0;
    if (now < cooldownUntil) continue;
    try {
      const results = await serpapiSearch(key, query, num);
      keyCooldown.delete(key);
      return results;
    } catch (err) {
      stats.keyFailures[KEYS.serpapi.indexOf(key)] += 1;
      // Quota/auth failures exhaust the key; anything else (rate, transient)
      // gets a short cooldown so the next call can retry it.
      const exhausting = isExhausting(err);
      keyCooldown.set(key, Date.now() + (exhausting ? 12 * 3600_000 : KEY_COOLDOWN_MS));
      console.error(`[search-relay] serpapi key #${KEYS.serpapi.indexOf(key)} failed: ${err.message} (cooldown ${exhausting ? "12h" : `${KEY_COOLDOWN_MS / 1000}s`})`);
    }
  }
  throw new Error("all serpapi keys exhausted or cooling down (glm fallback not wired)");
}

// ── request-scoped upstream key override (add-search-byok D3) ───────────────
// A caller may bring its own SerpAPI key on the request (`X-Serpapi-Key`).
// The override is tried FIRST; on failure the request falls back to the shared
// pool and says so (`x-search-source: pool-after-user-failure`) — never
// silently. Nothing about the override key is persisted; attribution in logs
// is a hash prefix only, so a leaked log line cannot leak the key.
//
// With the lane configured (search-relay-via-ciyuan D6) the override rides the
// lane call instead and the lane implements prefer/fallback/naming; this local
// chain is then the COLD-STANDBY path (lane outage or open breaker).
const overrideCooldown = new Map(); // sha256-prefix -> until-ts
function overrideTag(key) {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
}
function overrideSearch(overrideKey) {
  const tag = overrideTag(overrideKey);
  const until = overrideCooldown.get(tag) || 0;
  if (Date.now() < until) return { state: "cooling", tag };
  return { state: "ready", tag };
}
// Returns { results, source } or throws when BOTH the override and the pool
// are unusable. `source` is "user" | "pool" | "pool-after-user-failure".
async function directSearchWithOverride(overrideKey, query, num) {
  let overrideFailed = false;
  if (overrideKey) {
    const o = overrideSearch(overrideKey, query, num);
    if (o.state === "ready") {
      try {
        const results = await serpapiSearch(overrideKey, query, num);
        overrideCooldown.delete(o.tag);
        stats.overrides.used += 1;
        return { results, source: "user" };
      } catch (err) {
        overrideFailed = true;
        stats.overrides.failed += 1;
        const exhausting = isExhausting(err);
        overrideCooldown.set(o.tag, Date.now() + (exhausting ? 12 * 3600_000 : KEY_COOLDOWN_MS));
        // Hash prefix only — NEVER the key value.
        console.error(`[search-relay] user key ${o.tag}… failed: ${err.message} (cooldown ${exhausting ? "12h" : `${KEY_COOLDOWN_MS / 1000}s`})`);
      }
    } else {
      overrideFailed = true;
    }
  }
  try {
    const results = await poolSearch(query, num);
    if (overrideFailed) {
      stats.overrides.fallback += 1;
      return { results, source: "pool-after-user-failure" };
    }
    return { results, source: "pool" };
  } catch (err) {
    if (overrideFailed) {
      throw new Error(`${err.message} (user key also failed — every source is unavailable)`);
    }
    throw err;
  }
}

// Lane source header → the relay's caller-visible three states (D4). The
// routing fact (lane vs standby) is an ops detail and only ever lands in stats.
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

// Top orchestrator (D5): lane first, cold standby on outage, breaker to skip
// the doomed hop while it lasts. Returns { results, source, route }.
async function searchWithOverride(overrideKey, query, num) {
  if (KEYS.ciyuan) {
    // The breaker may only sideline the lane when a standby can actually
    // serve; with no standby keys configured the lane is the only path.
    const standbyUsable = KEYS.serpapi.length > 0;
    if (!standbyUsable || !laneBreakerOpen()) {
      try {
        const { results, laneSource } = await ciyuanSearch(query, num, overrideKey);
        laneSuccess();
        return { results, source: sourceFromLane(laneSource), route: "lane" };
      } catch (err) {
        if (!err.laneOutage) throw err; // lane 4xx shape errors are the request's problem
        laneFailure(err);
        if (!standbyUsable) throw new Error(`lane unavailable (${err.message}); no cold standby configured`);
        console.error(`[search-relay] lane outage → cold standby: ${err.message}`);
      }
    } else {
      console.error("[search-relay] lane breaker open → cold standby (probe on next window)");
    }
    stats.lane.fallbacks += 1;
    try {
      const direct = await directSearchWithOverride(overrideKey, query, num);
      return { ...direct, route: "direct-fallback" };
    } catch (err) {
      // Both paths are down: say so, and name the lane failure that started it.
      throw new Error(`lane unavailable and cold standby exhausted — ${err.message}`);
    }
  }
  const direct = await directSearchWithOverride(overrideKey, query, num);
  return { ...direct, route: "direct" };
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
  // token prefixes, scope ids, and key indexes only — never a token value
  // (spec: ops-console, stats scenario).
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
      keys: KEYS.serpapi.map((k, i) => ({
        index: i,
        failures: stats.keyFailures[i] ?? 0,
        coolingDown: Date.now() < (keyCooldown.get(k) || 0),
      })),
      // Upstream routing (search-relay-via-ciyuan D4): the lane is the
      // supply; the direct path is cold standby. mode reflects configuration,
      // not per-request luck — per-request routing lands in fallbacks/logs.
      upstream: {
        mode: KEYS.ciyuan ? "ciyuan" : "direct",
        laneConfigured: Boolean(KEYS.ciyuan),
        reachable: KEYS.ciyuan ? !laneBreakerOpen() : null,
        breakerOpen: KEYS.ciyuan ? laneBreakerOpen() : false,
        laneCalls: stats.lane.calls,
        laneFailures: stats.lane.failures,
        fallbacks: stats.lane.fallbacks,
      },
      // Request-scoped user keys (add-search-byok): counts only, never values.
      overrides: { ...stats.overrides },
      errors: {
        client: stats.clientErrors,
        upstream: stats.upstreamErrors,
        poolDry: stats.poolDry,
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
      if (/all serpapi keys exhausted/i.test(err.message)) stats.poolDry += 1;
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
