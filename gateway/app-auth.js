// ── App device-pairing identity path (openspec: add-device-pairing-auth) ─────
//
// The universal client (see ADR-0020 and the glossary's 通用客户端/设备配对)
// cannot run the Logto browser redirect either — but unlike the mini program
// it has no WeChat to vouch for it, so the device brings its OWN proof: an
// Ed25519 keypair whose private half never leaves the device. First pairing
// redeems the same web-session bind code the mini program uses (one minting
// pool, shared lifecycle) and registers the device's PUBLIC key under an
// `app:<deviceId>` binding; every later launch is a single-use nonce
// challenge answered with a signature. Tokens are the SAME hand-rolled HS256
// JWTs the mini program path issues (signMpJwt + MP_TOKEN_SECRET), carrying
// the ACCOUNT identity — so resolveUser/cell routing treat an app token
// exactly like a mini-program token. Only two claims differ: `kind: "app"`
// and `did: <deviceId>` (absent on mini-program tokens).
//
// Shared verbatim by the gateway (gateway/index.js) and the single-process
// server (server/routes/app.js), like mp-auth before it.
//
// Wire format (design D2): the public key travels as base64url of the RAW
// 32-byte Ed25519 key — @noble/ed25519's native output on the app side — and
// is wrapped into a node KeyObject via JWK ({kty:"OKP", crv:"Ed25519", x}).
// The signed message is the UTF-8 concatenation `deviceId + ":" + nonce`.
// Ed25519 signing is deterministic (RFC 8032), so the fixed vector in
// scripts/test-app-pairing.mjs (seed = RFC 8032 TEST 1) pins byte-identical
// signatures across node:crypto and @noble/ed25519.

import crypto from "node:crypto";
import { signMpJwt, verifyMpJwt } from "./mp-auth.js";
import { APP_KEY_PREFIX } from "./mp-bindings.js";

// A challenge is worthless minutes after issue; 60s is plenty for one
// roundtrip on any network a phone would tolerate anyway.
const CHALLENGE_TTL_MS = 60 * 1000;
// Hard ceiling on outstanding nonces: each is ~100 bytes, so this bounds
// challenge memory to ~1MB even under abuse. Swept lazily on issue.
const CHALLENGE_MAX_OUTSTANDING = 10_000;
// Self-reported device label: display-only, never parsed, capped.
const LABEL_MAX_CHARS = 64;

// base64url raw 32 bytes is exactly 43 chars (no padding) — reject anything
// else before decoding, so malformed keys never reach KeyObject wrapping.
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function ed25519KeyObject(pubkeyB64Url) {
  return crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pubkeyB64Url },
    format: "jwk",
  });
}

export function createAppAuth(config) {
  const { tokenSecret, ttlHours, bindings } = config;
  const configured = Boolean(tokenSecret);

  // deviceId -> { nonce, expiresAt }. ONE slot per device: a new challenge
  // replaces the old one, so replaying an intercepted older nonce is
  // structurally impossible even before the single-use consumption rule.
  const challenges = new Map();

  function sweepChallenges() {
    const now = Date.now();
    for (const [id, entry] of challenges) {
      if (entry.expiresAt <= now) challenges.delete(id);
    }
  }

  function mintToken(deviceId, email, groups) {
    const now = Math.floor(Date.now() / 1000);
    return signMpJwt(
      { sub: deviceId, did: deviceId, kind: "app", email, groups, iat: now, exp: now + ttlHours * 3600 },
      tokenSecret,
    );
  }

  // First pairing: bind code (minted from the account's web session) + the
  // device's identifier and public key. Mirrors mp-auth's loginWithBindCode
  // contract: 400 for malformed input, 401 for a wrong/expired/reused code,
  // and never a binding on failure.
  async function pair({ code, deviceId, pubkey, label }) {
    if (!configured) return { ok: false, status: 503, error: "App pairing is not configured" };
    const normalizedCode = typeof code === "string" ? code.trim() : "";
    if (!/^\d{6}$/.test(normalizedCode)) return { ok: false, status: 400, error: "请输入 6 位绑定码" };
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      return { ok: false, status: 400, error: "无效的设备标识" };
    }
    if (typeof pubkey !== "string" || !PUBKEY_RE.test(pubkey)) {
      return { ok: false, status: 400, error: "无效的设备公钥" };
    }
    // Wrap before consuming the code: a malformed key must not burn a valid
    // bind code (the user would have to mint another for a client bug).
    try {
      ed25519KeyObject(pubkey);
    } catch {
      return { ok: false, status: 400, error: "无效的设备公钥" };
    }
    const trimmedLabel = typeof label === "string" ? label.trim().slice(0, LABEL_MAX_CHARS) : "";

    const entry = bindings.consumeBindCode(normalizedCode);
    if (!entry) return { ok: false, status: 401, error: "绑定码无效或已过期" };

    await bindings.set(APP_KEY_PREFIX + deviceId, {
      email: entry.email,
      groups: entry.groups,
      pubkey,
      label: trimmedLabel,
    });
    return { ok: true, token: mintToken(deviceId, entry.email, entry.groups), email: entry.email };
  }

  // Challenge issuance. Unbound/revoked devices get the same answer whether
  // they never paired or were revoked: 401 + binding_required (the spec's
  // re-pair semantic) — the revocation fact is not leaked.
  function challenge({ deviceId }) {
    if (!configured) return { ok: false, status: 503, error: "App pairing is not configured" };
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      return { ok: false, status: 400, error: "无效的设备标识" };
    }
    const binding = bindings.get(APP_KEY_PREFIX + deviceId);
    if (!binding) return { ok: false, status: 401, error: "binding_required" };
    if (challenges.size >= CHALLENGE_MAX_OUTSTANDING) sweepChallenges();
    if (challenges.size >= CHALLENGE_MAX_OUTSTANDING) {
      return { ok: false, status: 503, error: "服务器繁忙，请稍后再试" };
    }
    const nonce = crypto.randomBytes(24).toString("base64url");
    challenges.set(deviceId, { nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return { ok: true, nonce, ttlMs: CHALLENGE_TTL_MS };
  }

  // Silent login: single-use nonce + Ed25519 signature over `deviceId:nonce`.
  // Failure ordering: unknown/revoked device first (401 binding_required —
  // same shape as challenge), then the nonce slot (401 — replay/expired),
  // then the signature itself (401). No status distinguishes them beyond
  // these; the error strings exist for logs, not for clients to branch on.
  function login({ deviceId, nonce, signature }) {
    if (!configured) return { ok: false, status: 503, error: "App pairing is not configured" };
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      return { ok: false, status: 400, error: "无效的设备标识" };
    }
    const binding = bindings.get(APP_KEY_PREFIX + deviceId);
    if (!binding) return { ok: false, status: 401, error: "binding_required" };
    const slot = challenges.get(deviceId);
    if (!slot || slot.expiresAt <= Date.now()) {
      challenges.delete(deviceId);
      return { ok: false, status: 401, error: "challenge 无效或已过期" };
    }
    const sig = typeof signature === "string" ? signature : "";
    const nonceStr = typeof nonce === "string" ? nonce : "";
    if (!sig || !nonceStr || nonceStr !== slot.nonce) {
      // Do NOT consume the slot on a mismatched nonce: a typo'd request
      // shouldn't invalidate the real holder's in-flight challenge.
      return { ok: false, status: 401, error: "challenge 校验失败" };
    }
    challenges.delete(deviceId); // consumed exactly here, win or lose
    let valid = false;
    try {
      valid = crypto.verify(
        null,
        Buffer.from(`${deviceId}:${nonceStr}`, "utf8"),
        ed25519KeyObject(binding.pubkey),
        Buffer.from(sig, "base64url"),
      );
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, status: 401, error: "签名验证失败" };
    return { ok: true, token: mintToken(deviceId, binding.email, binding.groups), email: binding.email };
  }

  // The web-side management surface. `devicesFor` lives on the bindings
  // store (it owns the namespace); revocation returns the same 404 for
  // "never paired" and "someone else's device", so one account can neither
  // enumerate nor destroy another's bindings. The caller is the account
  // email — on the wire that comes from a web session OR from an app
  // Bearer token (which carries the account identity), so an app can unbind
  // itself or any sibling device of the same account.
  async function revoke(email, deviceId) {
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      return { ok: false, status: 400, error: "无效的设备标识" };
    }
    const binding = bindings.get(APP_KEY_PREFIX + deviceId);
    if (!binding || binding.email !== email) return { ok: false, status: 404, error: "未找到该设备" };
    await bindings.remove(APP_KEY_PREFIX + deviceId);
    challenges.delete(deviceId);
    return { ok: true };
  }

  // Identity behind an app Bearer token (the single-process routes use this
  // where the gateway's resolveUser does the same job): null for anything
  // that is not a valid kind=app token.
  function accountFromToken(token) {
    const payload = verifyToken(token);
    if (!payload || payload.kind !== "app" || typeof payload.did !== "string") return null;
    return { email: payload.email, groups: payload.groups ?? [], did: payload.did };
  }

  function verifyToken(token) {
    if (!configured) return null;
    return verifyMpJwt(token, tokenSecret);
  }

  return { pair, challenge, login, revoke, devicesFor: bindings.devicesFor, accountFromToken, configured };
}
