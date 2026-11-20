// ciyuan-account-credentials.js — the user's 词元 (萬星·词元) account binding
// (ciyuan-account-lane, design D4/D5).
//
// One server-minted long-lived `sk-` key per identity: the connect route logs
// the user into 词元 with the credentials they type, mints a key through the
// 词元 key API, stores ONLY the key here, and discards the password and login
// token. The same key serves two consumers:
//   - the cell's model lane (dsh-profile ensureCredentialsStore overrides the
//     deployment seed for the 词元 provider ref in hosted cells),
//   - the wanxing-caller operations MCP ref (credential-refs: account key
//     preferred, a legacy pasted caller key kept as the fallback).
// Status never carries the key; DB unavailable degrades to "unconnected".

import * as db from "./db.js";
import * as lineCredentials from "./line-credentials.js";
import { ownerKey } from "./registry-credentials.js";

export const CIYUAN_ACCOUNT_CREDENTIAL_REF = "ciyuan-account";

const UNCONNECTED = Object.freeze({
  connected: false,
  stale: false,
  source: null,
  keyName: null,
  mintedAt: null,
  ciyuanEmailMasked: null,
});

// Whitelist projection: the fields below and nothing else. `source` says which
// store answered — the account binding or a legacy pasted wanxing-caller key.
function projectAccount(row) {
  return {
    connected: !row.stale && Boolean(row.token),
    stale: Boolean(row.stale),
    source: "account",
    keyName: row.keyName ?? null,
    mintedAt: row.mintedAt ?? null,
    ciyuanEmailMasked: row.ciyuanEmailMasked ?? null,
  };
}

export function status(email) {
  const key = ownerKey(email);
  const row = db.getCiyuanAccount(key);
  if (row) return projectAccount(row);
  const legacy = lineCredentials.status(key, "wanxing-caller");
  if (legacy.connected || legacy.stale) {
    return { ...UNCONNECTED, connected: legacy.connected, stale: legacy.stale, source: "pasted-key" };
  }
  return { ...UNCONNECTED };
}

// `ab***@example.com` — enough to recognise which 词元 login was bound,
// never enough to be a credential.
export function maskEmail(value) {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const [local, domain] = value.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

export function store({ email, token, keyId = null, keyName = null, groupId = null, ciyuanEmail = null }) {
  if (typeof token !== "string" || !token.trim().startsWith("sk-")) return null;
  const key = ownerKey(email);
  db.setCiyuanAccount({
    email: key,
    token: token.trim(),
    keyId,
    keyName,
    groupId,
    ciyuanEmailMasked: maskEmail(ciyuanEmail),
  });
  return status(key);
}

// Disconnect drops whichever source is serving the card — the account row
// and any legacy pasted caller key — so the card truly goes dark locally.
export function disconnect(email) {
  const key = ownerKey(email);
  let removed = db.clearCiyuanAccount(key);
  removed = lineCredentials.disconnect(key, "wanxing-caller") || removed;
  return removed;
}

// A 401 against the active source: flip the account row stale, or — when only
// a legacy pasted key exists — flip that one through line-credentials. Returns
// true when state changed (= re-apply exactly once).
export function markStale(email) {
  const key = ownerKey(email);
  const row = db.getCiyuanAccount(key);
  if (row) {
    if (row.stale) return false;
    return db.markCiyuanAccountStale(key, true);
  }
  return lineCredentials.markInvalid(key, "wanxing-caller");
}

// A probe that came back 200 against a stale account row heals it.
export function markHealthy(email) {
  const key = ownerKey(email);
  const row = db.getCiyuanAccount(key);
  if (!row || !row.stale) return false;
  return db.markCiyuanAccountStale(key, false);
}

// The injectable key: the account binding first, a legacy pasted caller key
// second; null when neither is live (stale or absent).
export function liveToken(email) {
  const key = ownerKey(email);
  const row = db.getCiyuanAccount(key);
  if (row) return row.stale ? null : row.token;
  return lineCredentials.liveToken(key, "wanxing-caller");
}

// The stored key regardless of staleness — for the connect card's probe only,
// so a healed upstream can heal a stale row. Never used for injection.
export function storedKeyForProbe(email) {
  const key = ownerKey(email);
  const row = db.getCiyuanAccount(key);
  if (row) return row.token;
  return db.getLineCredential(key, "wanxing-caller")?.token ?? null;
}
