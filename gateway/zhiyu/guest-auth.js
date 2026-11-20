// ── Zhiyu guest auth (add-zhiyu-website-embed, design D-B) ───────────────────
//
// Pure helpers + the two issuance flows for the widget lane. Three artifacts:
//   wtr_<id>.<sec>    — the room's embed permit (host's snippet). id looks up
//                       the row; only sha256(sec) is stored, never plaintext.
//   zy_guest / tty    — ONE-HMAC-signed visitor pass (cookie double-rail):
//                       { room, ref, exp, nonce } signed with the module
//                       secret (desk-embed convention, own salt).
//   sk_<id>.<sec>     — the host's identify site-secret: presented as a
//                       bearer over TLS + ts window + one-shot nonce.

import crypto from "node:crypto";

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hmac = (secret, s) => crypto.createHmac("sha256", secret).update(s, "utf8").digest("base64url");

export function newWidgetToken() {
  // wtr_<id>.<sec> — id is the DB key; sec is what the hash check binds.
  const id = crypto.randomBytes(6).toString("hex");
  const sec = crypto.randomBytes(16).toString("hex");
  return { token: `wtr_${id}.${sec}`, id, secHash: sha256(sec), fingerprint: sha256(`wtr_${id}.${sec}`).slice(0, 10) };
}

export function newSiteSecret() {
  const id = crypto.randomBytes(4).toString("hex");
  const sec = crypto.randomBytes(16).toString("hex");
  return { secret: `sk_${id}.${sec}`, id, secretHash: sha256(sec) };
}

export function parseTokenParts(raw, prefix) {
  const m = new RegExp(`^${prefix}_(?<id>[0-9a-f]+)\\.(?<sec>[0-9a-f]{16,})$`).exec(String(raw ?? ""));
  return m ? { id: m.groups.id, sec: m.groups.sec } : null;
}

export function verifyWidgetToken(store, rawToken) {
  const parts = parseTokenParts(rawToken, "wtr");
  if (!parts) return null;
  const row = store.widgetTokenGet(parts.id);
  if (!row || row.revokedAt) return null;
  if (!crypto.timingSafeEqual(Buffer.from(row.secHash), Buffer.from(sha256(parts.sec)))) return null;
  return row;
}

// Host allowlist: exact host or *.suffix (apex INCLUDED — users expect
// *.partner.com to also cover partner.com itself). The loader supplies the
// page's real location host — we never trust the iframe URL alone (D-E).
export function hostAllowed(allowlist, pageHost) {
  if (!pageHost) return false;
  const h = String(pageHost).toLowerCase();
  return (allowlist ?? []).some((w) => {
    const x = String(w).toLowerCase().trim();
    if (!x) return false;
    if (x.startsWith("*.")) {
      const apex = x.slice(2);
      return h === apex || (h.endsWith(`.${apex}`) && h.length > apex.length);
    }
    return h === x;
  });
}

// Guest pass: opaque, room-scoped, expiring. Cookie + URL双轨 (ITP).
export function signGuestPass(secret, { roomId, ref, expSec }) {
  const payload = { v: 1, roomId, ref, exp: expSec, nonce: crypto.randomBytes(4).toString("hex") };
  const body = b64u(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

export function verifyGuestPass(secret, rawToken) {
  const [body, mac] = String(rawToken ?? "").split(".");
  if (!body || !mac) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmac(secret, body)), Buffer.from(mac))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p || p.v !== 1 || typeof p.roomId !== "string" || typeof p.ref !== "string") return null;
    if (!Number.isFinite(p.exp) || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// identify bearer: presented secret + fresh ts (±5min) + one-shot nonce.
// The presented sk_<id>.<sec> is NOT trusted to name its row — the row comes
// from the widget token; the presented secret must hash-match THAT row's
// current site_secret_hash (a rotation invalidates older presentations).
export function verifyIdentify(store, tokenRow, { presentedSecret, ts, nonce }) {
  if (!presentedSecret || !ts || !nonce) return false;
  const parts = parseTokenParts(presentedSecret, "sk");
  if (!parts) return false;
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  if (!crypto.timingSafeEqual(Buffer.from(tokenRow.siteSecretHash), Buffer.from(sha256(parts.sec)))) return false;
  return store.widgetNonceBurn(String(nonce), tokenRow.id);
}

export function guestRefFor() {
  return `g_${crypto.randomBytes(5).toString("hex")}`;
}
