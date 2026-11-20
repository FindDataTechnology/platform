// Scoped relay tokens + relay auth channels (add-mcp-credential-hygiene §1).
//
// Lane 1: pure token functions in services/search-relay/scoped-token.js
//         (derive → verify round trip, malformed, revoked, static coexistence).
// Lane 2: the real relay server booted on an ephemeral port with a temp
//         keys.json (RELAY_KEYS_FILE) — static+wsrc auth over HTTP, scope
//         revocation via keys.json HOT RELOAD, and the refuse-to-start guards
//         (no credential material / no lane) in a child process. The
//         websearch lane upstream is stubbed so the lane is hermetic: auth
//         outcomes are distinguishable by status (401 = auth failed,
//         anything else = auth passed).
//
// Run: node scripts/test-search-relay-scoped.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
function dirname(p) { return p.slice(0, p.lastIndexOf("/")); }

const {
  deriveScopedToken, parseScopedToken, verifyScopedToken, checkTokenAuth, SCOPED_PREFIX,
} = await import("../services/search-relay/scoped-token.js");

const MASTER = "unit-master-secret";
const SCOPE = "cell-abc123def456";

// ── Lane 1: pure functions ───────────────────────────────────────────────────

test("derive → verify round trip", () => {
  const tok = deriveScopedToken(MASTER, SCOPE);
  assert.ok(tok.startsWith(`${SCOPED_PREFIX}${SCOPE}-`));
  const v = verifyScopedToken(MASTER, tok, []);
  assert.equal(v.ok, true);
  assert.equal(v.scopeId, SCOPE);
});

test("derived token shape: 24-hex mac as the last dash segment", () => {
  const tok = deriveScopedToken(MASTER, SCOPE);
  const mac = tok.slice(tok.lastIndexOf("-") + 1);
  assert.match(mac, /^[0-9a-f]{24}$/);
});

test("scope ids may contain dashes; parse recovers the full scope", () => {
  const scope = "cell-with-dashes-789";
  const tok = deriveScopedToken(MASTER, scope);
  assert.equal(parseScopedToken(tok).scopeId, scope);
});

test("verify rejects bad mac / wrong master / malformed", () => {
  const tok = deriveScopedToken(MASTER, SCOPE);
  const tampered = tok.slice(0, -2) + (tok.endsWith("00") ? "11" : "00");
  assert.equal(verifyScopedToken(MASTER, tampered, []).ok, false);
  assert.equal(verifyScopedToken("other-master", tok, []).ok, false);
  assert.equal(verifyScopedToken(MASTER, "wsrc-not-a-token", []).ok, false);
  assert.equal(verifyScopedToken(MASTER, null, []).ok, false);
});

test("revoked scope is denied, other scopes unaffected", () => {
  const a = deriveScopedToken(MASTER, "cell-aaa");
  const b = deriveScopedToken(MASTER, "cell-bbb");
  assert.equal(verifyScopedToken(MASTER, a, ["cell-aaa"]).ok, false);
  assert.equal(verifyScopedToken(MASTER, b, ["cell-aaa"]).ok, true);
});

test("checkTokenAuth: static first, scoped second, attribution tags", () => {
  assert.deepEqual(
    checkTokenAuth("static-tok-123", { tokens: ["static-tok-123"] }),
    { ok: true, tag: "static…" },
  );
  const tok = deriveScopedToken(MASTER, SCOPE);
  assert.deepEqual(
    checkTokenAuth(tok, { tokens: [], scopedMaster: MASTER }),
    { ok: true, tag: `wsrc:${SCOPE}` },
  );
  const revoked = checkTokenAuth(tok, { tokens: [], scopedMaster: MASTER, revokedScopes: [SCOPE] });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, "revoked");
  assert.equal(checkTokenAuth("", {}).reason, "missing");
});

test("deriveScopedToken validates inputs", () => {
  assert.throws(() => deriveScopedToken("", SCOPE));
  assert.throws(() => deriveScopedToken(MASTER, "-leading-dash"));
  assert.throws(() => deriveScopedToken(MASTER, "trailing-dash-"));
  assert.throws(() => deriveScopedToken(MASTER, ""));
});

// ── Lane 2: live server ──────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "scoped-relay-test-"));
const keysFile = join(tmp, "keys.json");
const STATIC = "static-live-token-zzz";
const LANE_URL = "https://ciyuan.scoped.test";
const LANE = { url: LANE_URL, key: "sk-lane-scoped-stub" };
function writeKeys(cfg) {
  writeFileSync(keysFile, JSON.stringify(cfg));
}

// Hermetic upstream: websearch-lane calls answer a valid envelope without
// touching the network, so successful searches exercise the full 200 path
// (per-token accounting included). Auth verdicts stay observable: 401 = auth
// failed, 200 = passed AND served.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith(LANE_URL)) {
    return new Response(
      JSON.stringify({ meta: { engine: "serpapi" }, results: [{ title: "t", url: "https://unit.test", snippet: "s" }], usage: {} }),
      { status: 200, headers: { "content-type": "application/json", "x-search-source": "pool" } },
    );
  }
  return realFetch(url, opts);
};

test("live relay: static + scoped auth, revocation via hot reload", async (t) => {
  writeKeys({ ciyuan: LANE, tokens: [STATIC], scoped_master: MASTER, revoked_scopes: [] });
  process.env.RELAY_KEYS_FILE = keysFile;
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  const relay = await import("../services/search-relay/index.js");
  t.after(() => {
    relay.relayServer.close();
    delete process.env.RELAY_KEYS_FILE;
  });
  if (!relay.relayServer.listening) await once(relay.relayServer, "listening");
  const base = `http://127.0.0.1:${relay.relayServer.address().port}`;
  let q = 0;
  const search = (tok) => {
    q += 1; // distinct query per call — the response cache must not absorb the probe
    return realFetch(`${base}/v1/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ query: `unit-${q}`, num: 1 }),
    });
  };

  // static token: served (auth passed)
  assert.equal((await search(STATIC)).status, 200);
  // scoped token: served the same way
  const scoped = deriveScopedToken(MASTER, SCOPE);
  assert.equal((await search(scoped)).status, 200);
  // garbage: rejected
  assert.equal((await search("nope")).status, 401);
  // scoped token against the WRONG master: rejected
  assert.equal((await search(deriveScopedToken("other", SCOPE))).status, 401);

  // HOT RELOAD: revoke the scope by editing keys.json (bump mtime explicitly —
  // filesystem mtime granularity can hide a fast rewrite).
  writeKeys({ ciyuan: LANE, tokens: [STATIC], scoped_master: MASTER, revoked_scopes: [SCOPE] });
  const future = new Date(Date.now() + 5000);
  utimesSync(keysFile, future, future);
  assert.equal((await search(scoped)).status, 401, "revoked scope must 401 after keys.json edit, no restart");
  // static channel unaffected by the revocation
  assert.equal((await search(STATIC)).status, 200);

  // scoped usage is attributed by scope id in /v1/stats, never by token value
  const stats = await (await realFetch(`${base}/v1/stats`, { headers: { authorization: `Bearer ${STATIC}` } })).json();
  assert.ok(!JSON.stringify(stats).includes(scoped), "stats must never carry a token value");
  assert.ok(stats.scopes.some((s) => s.scope === SCOPE), "stats should attribute the scoped usage");
});

// Both start guards run in a child process (the module calls process.exit).
const relayEntry = join(repoRoot, "services", "search-relay", "index.js");
const cleanEnv = { ...process.env, RELAY_TOKENS: "", RELAY_SCOPED_MASTER: "", CIYUAN_URL: "", CIYUAN_KEY: "" };

test("live relay: refuse-to-start guard when no credential material", () => {
  const noCreds = join(tmp, "no-creds-keys.json");
  writeFileSync(noCreds, JSON.stringify({ ciyuan: LANE }));
  const r = spawnSync(process.execPath, [relayEntry], {
    cwd: repoRoot,
    env: { ...cleanEnv, RELAY_KEYS_FILE: noCreds },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.notEqual(r.status, 0, "relay must exit non-zero without tokens or scoped master");
  assert.match(r.stderr, /no credential material configured/);
});

test("live relay: refuse-to-start guard when no lane (the only supply, retire-search-relay-direct)", () => {
  const noLane = join(tmp, "no-lane-keys.json");
  // A leftover serpapi[] is not a supply any more — must not satisfy the guard.
  writeFileSync(noLane, JSON.stringify({ tokens: [STATIC], serpapi: ["leftover"] }));
  const r = spawnSync(process.execPath, [relayEntry], {
    cwd: repoRoot,
    env: { ...cleanEnv, RELAY_KEYS_FILE: noLane },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.notEqual(r.status, 0, "relay must exit non-zero without a lane");
  assert.match(r.stderr, /no search upstream configured/);
  assert.doesNotMatch(r.stderr + r.stdout, /standby/, "startup output never mentions a standby");
});

test.after(() => {
  rmSync(tmp, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});
