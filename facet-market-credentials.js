// facet-market-credentials.js — per-user 谦面市场设备凭据 (add-facet-market-credentials).
//
// The market's app tokens live 12h (MP_TOKEN_TTL_HOURS) — a pasted terminal
// token is not viable. Instead each identity holds ONE device identity
// (Ed25519 keypair) that pairs once via the facet market's existing
// device-pairing-auth protocol (bind code → POST /api/app/pair), then mints
// fresh tokens silently (challenge → sign `deviceId:nonce` → login) whenever
// a profile write needs one.
//
// Contract with credential-refs.js (sync liveToken): the token cache is
// returned synchronously; a cache that is empty or nearing expiry (≤10min
// margin) triggers a fire-and-forget ensureFresh — the NEXT write picks up
// the fresh token. ensureFresh is serialized per identity: the challenge
// slot is single-occupancy (a second concurrent login would 401 on the
// consumed nonce).
//
// Private key and token live only here and in the generated dsh profile —
// never in any response or log (projections below). DB unavailable degrades
// to "unconnected", same as the registry/connector layers.

import crypto from "node:crypto";
import * as db from "./db.js";
import { ownerKey } from "./registry-credentials.js";

export const FACET_MARKET_CREDENTIAL_REF = "facet-market";
export const DEVICE_LABEL = "壹座·谦面市场";

// Fresh-mint margin: a cache with less than this left is refreshed in the
// background while still being injected this round (exp is in seconds).
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

const UNCONNECTED = {
  connected: false,
  stale: false,
  facetAccount: null,
  pairedAt: null,
  tokenExpiresAt: null,
};

export function facetMarketUrl() {
  // 市场公网域（设备配对协议+面板指路都在它上），与 FACET_BASE_URL（同 pod
  // facet 内部服务，k8s 自动注入的 env 会指向 127.0.0.1:3200——生产实测）无关。
  // 专用 env 名避免误吸内部基址；缺省=谦面市场生产域。
  return (
    process.env.FACET_MARKET_URL ||
    "https://facet.finddatatech.cloud"
  ).replace(/\/+$/, "");
}

export function isFacetMarketRef(config) {
  return config?.credentialRef === FACET_MARKET_CREDENTIAL_REF;
}

// ── device identity ──────────────────────────────────────────────────────────

function newDeviceIdentity(email) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  // Server contract (gateway/app-auth.js PUBKEY_RE): raw 32 bytes, base64url,
  // exactly 43 chars, no padding.
  const raw32 = publicKey.export({ format: "jwk" }).x;
  const deviceId = `yizuo-fm-${crypto
    .createHash("sha256")
    .update(`${email}:${crypto.randomBytes(8).toString("hex")}`)
    .digest("base64url")
    .slice(0, 24)}`;
  return { deviceId, publicKey: raw32, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

function signNonce(privateKeyPem, deviceId, nonce) {
  const signature = crypto.sign(
    null,
    Buffer.from(`${deviceId}:${nonce}`, "utf8"),
    crypto.createPrivateKey(privateKeyPem),
  );
  return signature.toString("base64url");
}

// ── status projection (secret-free) ─────────────────────────────────────────

function projectRow(row) {
  if (!row) return { ...UNCONNECTED };
  return {
    connected: !row.stale,
    stale: !!row.stale,
    facetAccount: row.facetEmail ?? null,
    pairedAt: row.pairedAt ?? null,
    tokenExpiresAt: row.tokenExp ?? null,
  };
}

export function status(email) {
  return projectRow(db.getFacetMarketDevice(ownerKey(email)));
}

// ── remote protocol (injectable fetch for tests) ────────────────────────────

async function pairRemote(email, code, fetchImpl) {
  const identity = newDeviceIdentity(email);
  const res = await fetchImpl(`${facetMarketUrl()}/api/app/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      deviceId: identity.deviceId,
      pubkey: identity.publicKey,
      label: DEVICE_LABEL,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = body?.error || `facet 市场配对应答 HTTP ${res.status}`;
    const err = new Error(error);
    err.status = res.status;
    throw err;
  }
  return { ...identity, token: body.token, facetEmail: body.email ?? null };
}

async function loginRemote(row, fetchImpl) {
  const ch = await fetchImpl(`${facetMarketUrl()}/api/app/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: row.deviceId }),
    signal: AbortSignal.timeout(10_000),
  });
  const chBody = await ch.json().catch(() => ({}));
  if (!ch.ok) {
    const err = new Error(chBody?.error || `challenge HTTP ${ch.status}`);
    err.status = ch.status;
    err.bindingRequired = chBody?.error === "binding_required" || ch.status === 401;
    throw err;
  }
  const login = await fetchImpl(`${facetMarketUrl()}/api/app/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: row.deviceId,
      nonce: chBody.nonce,
      signature: signNonce(row.privateKey, row.deviceId, chBody.nonce),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const loginBody = await login.json().catch(() => ({}));
  if (!login.ok) {
    const err = new Error(loginBody?.error || `login HTTP ${login.status}`);
    err.status = login.status;
    err.bindingRequired = loginBody?.error === "binding_required";
    throw err;
  }
  return { token: loginBody.token, facetEmail: loginBody.email ?? row.facetEmail };
}

function tokenExpMs(token) {
  // Read a JWT's exp without verifying: the platform only surfaces expiry;
  // the market validates the token itself.
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ── ensureFresh: serialized per identity ─────────────────────────────────────

const inflight = new Map(); // ownerKey → Promise

export async function ensureFresh(email, { fetchImpl = fetch } = {}) {
  const key = ownerKey(email);
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = (async () => {
    try {
      const row = db.getFacetMarketDevice(key);
      if (!row) return null; // unpaired — nothing to mint
      const { token, facetEmail } = await loginRemote(row, fetchImpl);
      db.setFacetMarketDeviceToken(key, token, tokenExpMs(token), facetEmail, /*stale=*/ false);
      return token;
    } catch (e) {
      if (e?.bindingRequired) {
        // Device revoked on the market: stale stays until the user re-pairs.
        db.markFacetMarketDeviceStale(key);
      }
      // Network/5xx: leave the cache alone (probe failures are not verdicts).
      console.warn(`[facet-market] silent relogin failed: ${e?.message || e}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

// ── pair / disconnect ────────────────────────────────────────────────────────

export async function pair(email, code, { fetchImpl = fetch } = {}) {
  const key = ownerKey(email);
  const identity = await pairRemote(email, code, fetchImpl);
  db.setFacetMarketDevice({
    email: key,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    facetEmail: identity.facetEmail,
    token: identity.token,
    tokenExp: tokenExpMs(identity.token),
    stale: 0,
  });
  return projectRow(db.getFacetMarketDevice(key));
}

export async function disconnect(email, { fetchImpl = fetch } = {}) {
  const key = ownerKey(email);
  const row = db.getFacetMarketDevice(key);
  if (row?.token) {
    try {
      await fetchImpl(`${facetMarketUrl()}/api/app/bind/${encodeURIComponent(row.deviceId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${row.token}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // best-effort: a leftover binding on the market is the status quo
    }
  }
  db.deleteFacetMarketDevice(key);
  return { ok: true };
}

// ── credential-refs contract ─────────────────────────────────────────────────

// 401 from a facet-market MCP tool: the injected token died mid-flight.
// Returns true when state changed (= re-apply exactly once). stale blocks
// injection until a silent relogin succeeds (automatic recovery) or the
// user re-pairs (revoked binding — ensureFresh leaves stale in place).
export function markInvalid(email) {
  const key = ownerKey(email);
  const row = db.getFacetMarketDevice(key);
  if (!row || row.stale) return false;
  db.markFacetMarketDeviceStale(key); // stale=1 + token cache dropped
  return true;
}

// The token to inject into the effective profile, or null when there is none
// usable. Sync by contract; a thin/empty cache kicks a background relogin.
export function liveToken(email) {
  const key = ownerKey(email);
  const row = db.getFacetMarketDevice(key);
  if (!row || row.stale) return null;
  const exp = row.tokenExp;
  if (!row.token) {
    void ensureFresh(email).catch(() => {});
    return null;
  }
  if (exp && exp - Date.now() < REFRESH_MARGIN_MS) {
    void ensureFresh(email).catch(() => {});
  }
  return row.token;
}
