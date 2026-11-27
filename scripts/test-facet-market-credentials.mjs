// Unit tests — facet-market-credentials (add-facet-market-credentials).
// Run: node --test scripts/test-facet-market-credentials.mjs
//
// The module's remote hops (pair/challenge/login) are exercised against a
// fake fetch; the Ed25519 leg is verified against a real node:crypto
// counterpart so the wire format (raw32B base64url pubkey, `deviceId:nonce`
// message, base64url signature) is pinned to what gateway/app-auth.js
// verifies server-side.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fresh DB per process: the module reads db.js which binds one sqlite file.
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fm-cred-")), "data.db");
process.env.DB_PATH = DB_PATH;
process.env.FACET_MARKET_URL = "https://facet.test";

const db = await import("../db.js");
await db.initDb();
const fm = await import("../facet-market-credentials.js");

const EMAIL = "user@test.example";

// ── fake market ──────────────────────────────────────────────────────────────

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}

let mintSeq = 0;
function makeToken(expSecondsFromNow) {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64u(JSON.stringify({
    sub: "dev", kind: "app", email: "facet-user@test.example", jti: String(++mintSeq),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  }));
  return `${header}.${payload}.sig`;
}

let pairs = [];      // accepted pair payloads
let devices = new Map(); // deviceId -> { pubkey }
let challenges = new Map(); // deviceId -> nonce
let logins = [];     // login payloads (for signature assertions)
let marketState = { pairStatus: 200, challengeStatus: 200, loginStatus: 200 };

function fakeFetch(url, init = {}) {
  const u = String(url);
  const body = JSON.parse(init.body ?? "{}");
  if (u.endsWith("/api/app/pair")) {
    pairs.push(body);
    if (marketState.pairStatus !== 200) {
      return res(marketState.pairStatus, { error: "绑定码无效或已过期" });
    }
    devices.set(body.deviceId, body.pubkey);
    return res(200, { ok: true, token: makeToken(12 * 3600), email: "facet-user@test.example" });
  }
  if (u.endsWith("/api/app/challenge")) {
    if (marketState.challengeStatus !== 200) {
      return res(marketState.challengeStatus, { error: "binding_required" });
    }
    const nonce = b64u(crypto.randomBytes(24));
    challenges.set(body.deviceId, nonce);
    return res(200, { ok: true, nonce, ttlMs: 60000 });
  }
  if (u.endsWith("/api/app/login")) {
    logins.push(body);
    if (marketState.loginStatus !== 200) {
      const error = marketState.loginStatus === 401 ? "binding_required" : "login failed";
      return res(marketState.loginStatus, { error });
    }
    // Verify exactly like the market does (gateway/app-auth.js).
    const stored = devices.get(body.deviceId);
    const nonce = challenges.get(body.deviceId);
    assert.ok(stored, "login for a paired device");
    assert.equal(body.nonce, nonce, "nonce roundtrip");
    const keyObject = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: stored }, format: "jwk" });
    const valid = crypto.verify(
      null, Buffer.from(`${body.deviceId}:${body.nonce}`, "utf8"), keyObject,
      Buffer.from(body.signature, "base64url"),
    );
    if (!valid) return res(401, { error: "签名验证失败" });
    challenges.delete(body.deviceId);
    return res(200, { ok: true, token: makeToken(12 * 3600), email: "facet-user@test.example" });
  }
  if (u.includes("/api/app/bind/")) {
    return res(200, { ok: true });
  }
  return res(404, { error: "unknown" });

  function res(status, body) {
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    });
  }
}

// The module's fire-and-forget background relogin (from liveToken) uses the
// DEFAULT fetch — point it at the fake market too, or a doomed real-fetch
// round holds the per-identity serial lock and sinks later assertions.
globalThis.fetch = fakeFetch;

// ── tests ────────────────────────────────────────────────────────────────────

test("unpaired status is unconnected and exposes no secrets", () => {
  const s = fm.status(EMAIL);
  assert.equal(s.connected, false);
  assert.equal(s.stale, false);
  assert.equal(s.facetAccount, null);
  assert.ok(!JSON.stringify(s).includes("privateKey"));
});

test("pair redeems a bind code: device row + wire format + first token", async () => {
  const status = await fm.pair(EMAIL, "123456", { fetchImpl: fakeFetch });
  assert.equal(status.connected, true);
  assert.equal(status.facetAccount, "facet-user@test.example");
  assert.equal(status.tokenExpiresAt !== null, true);
  const pair = pairs.at(-1);
  assert.match(pair.deviceId, /^[A-Za-z0-9._-]{1,64}$/);
  assert.match(pair.pubkey, /^[A-Za-z0-9_-]{43}$/, "raw 32B base64url pubkey");
  assert.equal(pair.label, fm.DEVICE_LABEL);
  // liveToken returns the paired cache synchronously.
  const token = fm.liveToken(EMAIL);
  assert.equal(typeof token, "string");
  assert.ok(token.split(".").length === 3);
});

test("pair failure (bad code) leaves no local row", async () => {
  marketState.pairStatus = 401;
  await assert.rejects(() => fm.pair("other@test.example", "000000", { fetchImpl: fakeFetch }));
  marketState.pairStatus = 200;
  assert.equal(fm.status("other@test.example").connected, false);
});

test("ensureFresh mints silently; signature verifies market-side", async () => {
  const before = fm.liveToken(EMAIL);
  // force a relogin by clearing the cache only (device identity intact)
  db.clearFacetMarketDeviceToken(EMAIL);
  assert.equal(fm.liveToken(EMAIL), null, "empty cache → null this round");
  const token = await fm.ensureFresh(EMAIL, { fetchImpl: fakeFetch });
  assert.equal(typeof token, "string");
  assert.notEqual(token, before);
  assert.equal(logins.length >= 1, true, "a real challenge/login round happened");
  assert.equal(fm.status(EMAIL).connected, true);
});

test("concurrent ensureFresh runs exactly one challenge round", async () => {
  db.deleteFacetMarketDevice(EMAIL);
  await fm.pair(EMAIL, "223344", { fetchImpl: fakeFetch });
  db.clearFacetMarketDeviceToken(EMAIL);
  const loginsBefore = logins.length;
  await Promise.all([
    fm.ensureFresh(EMAIL, { fetchImpl: fakeFetch }),
    fm.ensureFresh(EMAIL, { fetchImpl: fakeFetch }),
    fm.ensureFresh(EMAIL, { fetchImpl: fakeFetch }),
  ]);
  assert.equal(logins.length - loginsBefore, 1, "serialized: one login for all callers");
});

test("markInvalid flips once and auto-recovers via ensureFresh", async () => {
  assert.equal(fm.markInvalid(EMAIL), true, "state changed → re-apply once");
  assert.equal(fm.markInvalid(EMAIL), false, "second call is a no-op");
  assert.equal(fm.liveToken(EMAIL), null);
  const token = await fm.ensureFresh(EMAIL, { fetchImpl: fakeFetch });
  assert.equal(typeof token, "string");
  assert.equal(fm.status(EMAIL).connected, true, "auto-recovered");
});

test("revoked binding keeps stale — no zombie resurrection", async () => {
  marketState.challengeStatus = 401; // binding_required
  await fm.ensureFresh(EMAIL, { fetchImpl: fakeFetch });
  marketState.challengeStatus = 200;
  const s = fm.status(EMAIL);
  assert.equal(s.stale, true, "revocation marked stale");
  assert.equal(fm.liveToken(EMAIL), null);
  // Stale is cleared only by an explicit re-pair.
  const status = await fm.pair(EMAIL, "334455", { fetchImpl: fakeFetch });
  assert.equal(status.connected, true);
  assert.equal(status.stale, false);
});

test("disconnect drops the row and best-effort revokes", async () => {
  const out = await fm.disconnect(EMAIL, { fetchImpl: fakeFetch });
  assert.equal(out.ok, true);
  assert.equal(fm.status(EMAIL).connected, false);
  assert.equal(fm.liveToken(EMAIL), null);
});

test("expiring cache triggers background refresh while still injecting", async () => {
  await fm.pair(EMAIL, "445566", { fetchImpl: fakeFetch });
  const row = db.getFacetMarketDevice(EMAIL);
  // Force expiry inside the 10min margin.
  db.setFacetMarketDeviceToken(EMAIL, row.token, Date.now() + 60_000, row.facetEmail, false);
  const t1 = fm.liveToken(EMAIL);
  assert.equal(typeof t1, "string", "thin token still injected this round");
  await new Promise((r) => setTimeout(r, 50)); // let the background relogin land
  const refreshed = db.getFacetMarketDevice(EMAIL);
  assert.ok(refreshed.tokenExp > Date.now() + 60_000, "cache was re-minted in the background");
});

test("credential-refs knows the facet-market ref", async () => {
  const refs = await import("../credential-refs.js");
  assert.equal(refs.knownRef("facet-market"), true);
  const config = { url: "http://x/mcp", credentialRef: "facet-market" };
  const entry = refs.refFor(config);
  assert.equal(entry?.refName, "facet-market");
});
