#!/usr/bin/env node
// Full-chain device-pairing smoke probe (openspec: add-device-pairing-auth,
// task 5.2). Plays the ROLE OF THE FUTURE APP CLIENT against a real
// deployment — a genuine Ed25519 keypair, the exact wire format from
// gateway/app-auth.js design D2 — and walks the seven-step contract:
//
//   1. mint      the web session mints a bind code (the shared pool)
//   2. pair      code + deviceId + pubkey → account-identity JWT (kind=app)
//   3. challenge deviceId → single-use nonce
//   4. login     nonce signature → fresh JWT (the silent-launch exchange)
//   5. replay    the same nonce again → 401
//   6. revoke    DELETE the device from the web side
//   7. relogin   the revoked device's challenge → 401 binding_required
//
// Usage:
//   node scripts/probe-app-pairing.mjs --base https://your-deployment \
//        [--cookie "paas_session=<signed value>"] \
//        [--fh "pairer@corp.com"]            # forward-auth identity instead
//
// One of --cookie / --fh is required (the web side must authenticate). Exit
// code 0 = all seven steps green.

import crypto from "node:crypto";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = (flag("base") || "").replace(/\/+$/, "");
const cookie = flag("cookie");
const fh = flag("fh");
if (!BASE) {
  console.error("usage: probe-app-pairing.mjs --base <url> [--cookie ... | --fh email]");
  process.exit(2);
}
if (!cookie && !fh) {
  console.error("need a web identity: --cookie \"paas_session=…\" or --fh email (forward_auth)");
  process.exit(2);
}

// The app side of the wire contract: raw 32-byte Ed25519 over base64url,
// signature on `deviceId:nonce` (mirrors @noble/ed25519's raw output shape).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const priv = crypto.createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, crypto.randomBytes(32)]),
  format: "der",
  type: "pkcs8",
});
const pubkey = crypto.createPublicKey(priv).export({ format: "jwk" }).x;
const sign = (message) => crypto.sign(null, Buffer.from(message, "utf8"), priv).toString("base64url");

const webHeaders = {
  accept: "application/json",
  ...(cookie ? { cookie } : { "x-forwarded-email": fh, "x-forwarded-groups": "users" }),
};
const jsonPost = (path, body, headers = { "content-type": "application/json" }) =>
  fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

let failed = 0;
async function step(n, name, run) {
  try {
    const detail = await run();
    console.log(`PASS ${n}. ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${n}. ${name} — ${e.message}`);
  }
}
const assert = (cond, what) => {
  if (!cond) throw new Error(what);
};

const deviceId = `probe-${crypto.randomBytes(4).toString("hex")}`;
let minted;
let pairedToken;
let nonce;

// Note: /api/config is anonymously readable on logto shapes (gateway +
// single-process) but 401s without proxy identity on forward_auth — so the
// probe sends the web identity here. The future app probes anonymously and
// treats 401/absent as "capabilities unknown, just try pairing".
await step(1, "config advertises devicePairing", async () => {
  const cfg = await fetch(`${BASE}/api/config`, { headers: webHeaders }).then((r) => r.json());
  assert(cfg.capabilities?.devicePairing === true, `capabilities.devicePairing=${cfg.capabilities?.devicePairing}`);
  return "advertised";
});

await step(2, "web session mints a bind code", async () => {
  const r = await fetch(`${BASE}/api/mp/bindcode`, { headers: webHeaders });
  assert(r.ok, `HTTP ${r.status}`);
  minted = (await r.json()).code;
  assert(/^\d{6}$/.test(String(minted)), "no 6-digit code");
  return `code=${minted}`;
});

await step(3, "pair redeems code + pubkey → kind=app JWT", async () => {
  const r = await jsonPost("/api/app/pair", { code: minted, deviceId, pubkey, label: "probe-runner" });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  pairedToken = body.token;
  const claims = JSON.parse(Buffer.from(pairedToken.split(".")[1], "base64url").toString("utf8"));
  assert(claims.kind === "app" && claims.did === deviceId, "claims missing kind/did");
  return `email=${body.email} did=${claims.did}`;
});

await step(4, "challenge → nonce", async () => {
  const r = await jsonPost("/api/app/challenge", { deviceId });
  assert(r.status === 200, `HTTP ${r.status}`);
  nonce = (await r.json()).nonce;
  return "nonce issued";
});

await step(5, "signed login → fresh JWT (silent launch)", async () => {
  const r = await jsonPost("/api/app/login", {
    deviceId,
    nonce,
    signature: sign(`${deviceId}:${nonce}`),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return "token reissued";
});

await step(6, "replayed nonce → 401", async () => {
  const r = await jsonPost("/api/app/login", {
    deviceId,
    nonce,
    signature: sign(`${deviceId}:${nonce}`),
  });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return "rejected";
});

await step(7, "web revoke → device told to re-pair", async () => {
  const list = await fetch(`${BASE}/api/app/devices`, { headers: webHeaders });
  assert(list.ok, `devices HTTP ${list.status}`);
  const devices = await list.json();
  assert(devices.some((d) => d.deviceId === deviceId), "paired device missing from list");
  const del = await fetch(`${BASE}/api/app/bind/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: webHeaders,
  });
  assert(del.ok, `revoke HTTP ${del.status}`);
  const again = await jsonPost("/api/app/challenge", { deviceId });
  assert(again.status === 401, `expected 401 after revoke, got ${again.status}`);
  const body = await again.json().catch(() => ({}));
  assert(body.error === "binding_required", `error=${body.error}`);
  return "revoked, re-pair semantic confirmed";
});

console.log(failed === 0 ? "\nALL GREEN — pairing chain fully closed" : `\n${failed} step(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
