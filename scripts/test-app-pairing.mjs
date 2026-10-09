// Integration test for the app device-pairing identity path (openspec:
// add-device-pairing-auth). Three layers:
//
//   1. Module level — the generalized bindings store (app: namespace with
//      pubkey/label, old-format openid entries untouched, devicesFor) and the
//      app-auth branch matrix (400/401, code lifecycle, nonce replay,
//      revocation indistinguishable from never-bound, cross-account
//      isolation, inertness without MP_TOKEN_SECRET).
//   2. A fixed Ed25519 vector — the RFC 8032 TEST 1 seed pins the wire
//      format across stacks: node:crypto and @noble/ed25519 (the app side)
//      are both deterministic, so identical constants here mean identical
//      bytes there. Breaks if either the JWK-wrap import or the
//      `deviceId:nonce` message format drifts.
//   3. HTTP level on BOTH deployment shapes — the real gateway and the real
//      single-process server: mint → pair → challenge → login → devices →
//      revoke → 401, plus /api/config advertising capabilities.devicePairing.
//
// Runs under `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createMpBindings, APP_KEY_PREFIX } from "../gateway/mp-bindings.js";
import { createAppAuth } from "../gateway/app-auth.js";
import { verifyMpJwt } from "../gateway/mp-auth.js";
import { sessionCookie } from "../server/session.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Ed25519 helpers: node side of the wire contract ─────────────────────────
// Private keys import from a raw 32-byte seed via the fixed PKCS#8 Ed25519
// prefix; public keys travel as base64url raw bytes (the JWK `x` coordinate
// IS the raw key for OKP curves).

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function privateKeyFromSeed(seed) {
  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublicKey(priv) {
  return crypto.createPublicKey(priv).export({ format: "jwk" }).x;
}

function signMessage(priv, message) {
  return crypto.sign(null, Buffer.from(message, "utf8"), priv).toString("base64url");
}

// The pinned vector (RFC 8032 TEST 1 seed — its public key is the published
// d75a9801… test key, which doubles as an interop cross-check).
const VECTOR = {
  seedHex: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  message: "device-abc:nonce-123",
  pubkey:
    "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  signature:
    "N9-V2jE0Ql76ycmjAGTdiHK2ZiU55ucScm2tsRWoTzRj1xP03E2WS4uzXDlzABgG_ZiScuuCxkKr6v5ZmdaCBw",
};

function tmpStore() {
  return path.join(mkdtempSync(path.join(tmpdir(), "app-pairing-")), "bindings.json");
}

// ── 1. Bindings store generalization ─────────────────────────────────────────

test("bindings: app: entry persists pubkey/label and round-trips through reload", async () => {
  const file = tmpStore();
  const a = createMpBindings({ file });
  await a.load();
  await a.set(APP_KEY_PREFIX + "device-1", {
    email: "alpha@example.com",
    groups: ["users"],
    pubkey: VECTOR.pubkey,
    label: "Pixel 8",
  });
  await a.set("o-OPENID-1", { email: "alpha@example.com", groups: ["users"] });

  const b = createMpBindings({ file });
  await b.load();
  const appEntry = b.get(APP_KEY_PREFIX + "device-1");
  assert.equal(appEntry.pubkey, VECTOR.pubkey);
  assert.equal(appEntry.label, "Pixel 8");
  assert.equal(appEntry.email, "alpha@example.com");
  // The openid entry keeps its historical shape: no pubkey/label keys at all.
  const openidEntry = b.get("o-OPENID-1");
  assert.equal(openidEntry.pubkey, undefined);
  assert.equal(openidEntry.label, undefined);
});

test("bindings: an old-format file (openid only) loads unchanged", async () => {
  const file = tmpStore();
  const a = createMpBindings({ file });
  await a.load();
  await a.set("o-OLD-1", { email: "old@example.com", groups: [] });
  // Simulate a file written by the PRE-generalization binary: the entry on
  // disk has exactly {email, groups, boundAt}. set() adds nothing else for
  // openid callers, so this is already the legacy shape; assert it.
  const b = createMpBindings({ file });
  await b.load();
  const entry = b.get("o-OLD-1");
  assert.deepEqual(Object.keys(entry).sort(), ["boundAt", "email", "groups"]);
});

test("bindings: devicesFor lists only this account's devices, newest first, no pubkeys", async () => {
  const file = tmpStore();
  const store = createMpBindings({ file });
  await store.load();
  await store.set(APP_KEY_PREFIX + "d-old", { email: "alpha@example.com", groups: [], pubkey: VECTOR.pubkey, label: "old" });
  await new Promise((r) => setTimeout(r, 15));
  await store.set(APP_KEY_PREFIX + "d-new", { email: "alpha@example.com", groups: [], pubkey: VECTOR.pubkey, label: "new" });
  await store.set(APP_KEY_PREFIX + "d-beta", { email: "beta@example.com", groups: [], pubkey: VECTOR.pubkey, label: "beta" });
  await store.set("o-OPENID", { email: "alpha@example.com", groups: [] });

  const devices = store.devicesFor("alpha@example.com");
  assert.deepEqual(
    devices.map((d) => d.deviceId),
    ["d-new", "d-old"],
  );
  for (const d of devices) {
    assert.equal("pubkey" in d, false);
    assert.equal(typeof d.boundAt, "number");
  }
});

// ── 2. The pinned cross-stack vector ─────────────────────────────────────────

test("vector: node reproduces the pinned pubkey/signature (format contract)", () => {
  const priv = privateKeyFromSeed(Buffer.from(VECTOR.seedHex, "hex"));
  assert.equal(rawPublicKey(priv), VECTOR.pubkey);
  assert.equal(signMessage(priv, VECTOR.message), VECTOR.signature);
});

// ── 3. app-auth module branch matrix ─────────────────────────────────────────

function moduleHarness() {
  const bindings = createMpBindings({ file: tmpStore() });
  const auth = createAppAuth({ tokenSecret: "s3cret", ttlHours: 12, bindings });
  return { bindings, auth };
}

function freshDevice(seedHex = VECTOR.seedHex) {
  const priv = privateKeyFromSeed(Buffer.from(seedHex, "hex"));
  return { priv, pubkey: rawPublicKey(priv) };
}

test("app-auth: pairing happy path mints a kind=app token; wrong/reused codes rejected", async () => {
  const { bindings, auth } = moduleHarness();
  const { pubkey } = freshDevice();
  const mint = () => bindings.issueBindCode("alpha@example.com", ["users"]);

  const bad = await auth.pair({ code: "000000", deviceId: "dev-1", pubkey });
  assert.equal(bad.status, 401);
  assert.equal(bindings.get(APP_KEY_PREFIX + "dev-1"), null);

  const { code } = mint();
  const ok = await auth.pair({ code, deviceId: "dev-1", pubkey, label: "Pixel 8" });
  assert.equal(ok.ok, true);
  assert.equal(ok.email, "alpha@example.com");
  const payload = verifyMpJwt(ok.token, "s3cret");
  assert.equal(payload.kind, "app");
  assert.equal(payload.did, "dev-1");
  assert.equal(payload.email, "alpha@example.com");

  const reused = await auth.pair({ code, deviceId: "dev-2", pubkey });
  assert.equal(reused.status, 401);
  assert.equal(bindings.get(APP_KEY_PREFIX + "dev-2"), null);
});

test("app-auth: malformed pair input → 400, and a malformed key does not burn the code", async () => {
  const { bindings, auth } = moduleHarness();
  const { pubkey } = freshDevice();
  const { code } = bindings.issueBindCode("alpha@example.com", []);

  assert.equal((await auth.pair({ code: "12ab", deviceId: "dev-1", pubkey })).status, 400);
  assert.equal((await auth.pair({ code, deviceId: "bad id!", pubkey })).status, 400);
  const shortKey = await auth.pair({ code, deviceId: "dev-1", pubkey: "short" });
  assert.equal(shortKey.status, 400);
  // The code survived the malformed attempts and still redeems.
  const ok = await auth.pair({ code, deviceId: "dev-1", pubkey });
  assert.equal(ok.ok, true);
});

test("app-auth: challenge → login happy path on the pinned vector; replay rejected", async () => {
  const { bindings, auth } = moduleHarness();
  const { priv, pubkey } = freshDevice();
  const { code } = bindings.issueBindCode("alpha@example.com", ["users"]);
  await auth.pair({ code, deviceId: "device-abc", pubkey, label: "vec" });

  const ch = auth.challenge({ deviceId: "device-abc" });
  assert.equal(ch.ok, true);
  assert.equal(typeof ch.nonce, "string");

  const login = (nonce, sig) => auth.login({ deviceId: "device-abc", nonce, signature: sig });
  const good = login(ch.nonce, signMessage(priv, `device-abc:${ch.nonce}`));
  assert.equal(good.ok, true);
  assert.equal(verifyMpJwt(good.token, "s3cret").email, "alpha@example.com");

  // Same nonce again: consumed.
  const replay = login(ch.nonce, signMessage(priv, `device-abc:${ch.nonce}`));
  assert.equal(replay.status, 401);
});

test("app-auth: unknown device, wrong signature, wrong key all 401; revoked == never-bound", async () => {
  const { bindings, auth } = moduleHarness();
  const legit = freshDevice();
  const other = freshDevice("4ccd089b28ff96da9db6c346ec114e0f5b17a220a13e959a2afbdd5f79796e75");
  const { code } = bindings.issueBindCode("alpha@example.com", []);
  await auth.pair({ code, deviceId: "dev-1", pubkey: legit.pubkey });

  assert.equal(auth.challenge({ deviceId: "never-seen" }).status, 401);
  assert.equal(auth.login({ deviceId: "never-seen", nonce: "x", signature: "y" }).status, 401);

  const ch = auth.challenge({ deviceId: "dev-1" });
  const wrongKey = auth.login({ deviceId: "dev-1", nonce: ch.nonce, signature: signMessage(other.priv, `dev-1:${ch.nonce}`) });
  assert.equal(wrongKey.status, 401);
  // The failed verification consumed the nonce: a correct retry with the
  // same nonce must also fail (single-use even on losing).
  const retry = auth.login({ deviceId: "dev-1", nonce: ch.nonce, signature: signMessage(legit.priv, `dev-1:${ch.nonce}`) });
  assert.equal(retry.status, 401);

  // Revoke, then compare against a never-bound device: same status AND body.
  const revoke = await auth.revoke("alpha@example.com", "dev-1");
  assert.equal(revoke.ok, true);
  const afterRevoke = auth.challenge({ deviceId: "dev-1" });
  const never = auth.challenge({ deviceId: "ghost" });
  assert.equal(afterRevoke.status, never.status);
  assert.deepEqual(afterRevoke.error, never.error);
});

test("app-auth: cross-account isolation — other accounts see 404, not their data", async () => {
  const { bindings, auth } = moduleHarness();
  const { pubkey } = freshDevice();
  const { code } = bindings.issueBindCode("alpha@example.com", []);
  await auth.pair({ code, deviceId: "dev-1", pubkey, label: "alpha's phone" });

  assert.equal(bindings.devicesFor("beta@example.com").length, 0);
  assert.equal((await auth.revoke("beta@example.com", "dev-1")).status, 404);
  assert.equal((await auth.revoke("alpha@example.com", "dev-1")).ok, true);
  // Unknown ids look identical to foreign devices: same 404.
  assert.equal((await auth.revoke("beta@example.com", "ghost")).status, 404);
});

test("app-auth: inert without a token secret (503s, nothing verifies)", async () => {
  const bindings = createMpBindings({ file: tmpStore() });
  const auth = createAppAuth({ tokenSecret: "", ttlHours: 12, bindings });
  assert.equal((await auth.pair({ code: "123456", deviceId: "d", pubkey: VECTOR.pubkey })).status, 503);
  assert.equal(auth.challenge({ deviceId: "d" }).status, 503);
  assert.equal(auth.login({ deviceId: "d", nonce: "n", signature: "s" }).status, 503);
});

test("app-auth: a fresh challenge replaces the device's previous nonce", async () => {
  const { bindings, auth } = moduleHarness();
  const { priv, pubkey } = freshDevice();
  const { code } = bindings.issueBindCode("a@x", []);
  await auth.pair({ code, deviceId: "dev-1", pubkey });
  const first = auth.challenge({ deviceId: "dev-1" });
  const second = auth.challenge({ deviceId: "dev-1" });
  assert.notEqual(first.nonce, second.nonce);
  // The stale first nonce no longer matches the slot.
  const stale = auth.login({ deviceId: "dev-1", nonce: first.nonce, signature: signMessage(priv, `dev-1:${first.nonce}`) });
  assert.equal(stale.status, 401);
  const fresh = auth.login({ deviceId: "dev-1", nonce: second.nonce, signature: signMessage(priv, `dev-1:${second.nonce}`) });
  assert.equal(fresh.ok, true);
});

// ── 4. HTTP on the real gateway ──────────────────────────────────────────────

// Mock Logto discovery/JWKS (boot requirement — no test drives the browser
// flow; the app path never touches WeChat, so no js_code endpoint needed).
let mockPortSelf = 0;
const mockUpstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.endsWith("/.well-known/openid-configuration")) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        issuer: `http://127.0.0.1:${mockPortSelf}/oidc`,
        authorization_endpoint: `http://127.0.0.1:${mockPortSelf}/oidc/auth`,
        token_endpoint: `http://127.0.0.1:${mockPortSelf}/oidc/token`,
        jwks_uri: `http://127.0.0.1:${mockPortSelf}/oidc/jwks`,
      }),
    );
    return;
  }
  if (url.pathname.endsWith("/jwks")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [] }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
mockUpstream.on("listening", () => (mockPortSelf = mockUpstream.address().port));
await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
const mockPort = mockPortSelf;

const GATEWAY_PORT = 3000 + Math.floor(Math.random() * 2000);
const TOKEN_SECRET = "test-mp-token-secret";
const SESSION_SECRET = "test-session-secret";
const gateway = spawn(process.execPath, ["gateway/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    GATEWAY_PORT: String(GATEWAY_PORT),
    GATEWAY_HOST: "127.0.0.1",
    CELL_GATEWAY_SECRET: "test-cell-gateway-secret",
    CELL_DATA_ROOT: mkdtempSync(path.join(tmpdir(), "app-pairing-cells-")),
    SESSION_SECRET,
    AUTH_MODE: "logto",
    LOGTO_ENDPOINT: `http://127.0.0.1:${mockPort}`,
    LOGTO_APP_ID: "test-logto-app",
    LOGTO_APP_SECRET: "test-logto-secret",
    PAAS_BASE_URL: "",
    MP_APPID: "wx-test-appid",
    MP_SECRET: "wx-test-secret",
    MP_TOKEN_SECRET: TOKEN_SECRET,
    MP_TOKEN_TTL_HOURS: "12",
    MP_JS_CODE_URL: `http://127.0.0.1:${mockPort}/sns/jscode2session`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gatewayLog = "";
gateway.stdout.on("data", (b) => (gatewayLog += b));
gateway.stderr.on("data", (b) => (gatewayLog += b));

async function waitFor(port, probe) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${probe}`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} never became healthy:\n${gatewayLog}`);
}

function webCookie(email, groups = []) {
  const ttlMs = 60 * 60 * 1000;
  const payload = { email, groups, exp: Math.floor((Date.now() + ttlMs) / 1000) };
  return sessionCookie("paas_session", payload, SESSION_SECRET, ttlMs).split(";")[0];
}

const gw = (p, init) => fetch(`http://127.0.0.1:${GATEWAY_PORT}${p}`, init);
const post = (base, p, body, cookie) =>
  fetch(`http://127.0.0.1:${base}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

test("gateway: /api/config advertises capabilities.devicePairing anonymously", async () => {
  await waitFor(GATEWAY_PORT, "/healthz");
  const r = await gw("/api/config");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.capabilities?.devicePairing, true);
});

test("gateway: mint → pair → challenge → login → devices → revoke over HTTP", async () => {
  const cookie = webCookie("alpha@example.com", ["users"]);
  const device = freshDevice();
  const deviceId = "gw-device-1";

  // Mint from the web session (the shared pool — the MP door serves JSON too).
  const mint = await gw("/api/mp/bindcode", { headers: { cookie, accept: "application/json" } });
  assert.equal(mint.status, 200);
  const { code } = await mint.json();

  const pair = await post(GATEWAY_PORT, "/api/app/pair", { code, deviceId, pubkey: device.pubkey, label: "iPhone 17" });
  assert.equal(pair.status, 200);
  const { token } = await pair.json();

  // The app token flows through resolveUser: the devices list accepts it as
  // the caller identity, same as a browser cookie would.
  const viaBearer = await gw("/api/app/devices", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(viaBearer.status, 200);
  assert.equal((await viaBearer.json()).some((d) => d.deviceId === deviceId), true);

  const ch = await post(GATEWAY_PORT, "/api/app/challenge", { deviceId });
  assert.equal(ch.status, 200);
  const { nonce } = await ch.json();
  const login = await post(GATEWAY_PORT, "/api/app/login", {
    deviceId,
    nonce,
    signature: signMessage(device.priv, `${deviceId}:${nonce}`),
  });
  assert.equal(login.status, 200);

  // Web-side management: list shows the label, then revocation kills the
  // silent path with the same 401 a never-bound device gets.
  const list = await gw("/api/app/devices", { headers: { cookie } });
  assert.equal(list.status, 200);
  const devices = await list.json();
  assert.equal(devices.find((d) => d.deviceId === deviceId)?.label, "iPhone 17");
  assert.equal("pubkey" in (devices[0] ?? {}), false);

  const anon = await gw("/api/app/devices");
  assert.equal(anon.status, 401);

  const revoke = await gw(`/api/app/bind/${encodeURIComponent(deviceId)}`, { method: "DELETE", headers: { cookie } });
  assert.equal(revoke.status, 200);
  const after = await post(GATEWAY_PORT, "/api/app/challenge", { deviceId });
  assert.equal(after.status, 401);
  assert.equal((await after.json()).error, "binding_required");
});

test("gateway: self-unbind endpoint accepts the device's own token", async () => {
  const cookie = webCookie("alpha@example.com", []);
  const device = freshDevice();
  const mint = await gw("/api/mp/bindcode", { headers: { cookie, accept: "application/json" } });
  const { code } = await mint.json();
  const deviceId = "gw-device-2";
  const pair = await post(GATEWAY_PORT, "/api/app/pair", { code, deviceId, pubkey: device.pubkey });
  const { token } = await pair.json();

  const self = await gw(`/api/app/bind/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(self.status, 200);
  const ch = await post(GATEWAY_PORT, "/api/app/challenge", { deviceId });
  assert.equal(ch.status, 401);
});

test.after(async () => {
  mockUpstream.closeAllConnections?.();
  mockUpstream.close();
  if (gateway.exitCode !== null) return;
  const exited = new Promise((r) => gateway.once("exit", r));
  gateway.kill("SIGTERM");
  const timed = await Promise.race([
    exited.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 2000).unref()),
  ]);
  if (!timed) gateway.kill("SIGKILL");
});

// ── 5. HTTP on the single-process server ─────────────────────────────────────

const SP_PORT = 3000 + Math.floor(Math.random() * 2000);
const spScratch = mkdtempSync(path.join(tmpdir(), "app-pairing-sp-"));
const single = spawn(process.execPath, [path.join(REPO, "server.js")], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(SP_PORT),
    HOST: "127.0.0.1",
    PLATFORM_DATA_DIR: path.join(spScratch, "data"),
    DSH_HOME: path.join(spScratch, "dsh"),
    MCP_CONFIG_PATH: path.join(spScratch, "data", "mcp.json"),
    LLM_API_KEY: "",
    AUTH_MODE: "logto",
    LOGTO_ENDPOINT: `http://127.0.0.1:${mockPort}`,
    LOGTO_APP_ID: "test-logto-app",
    LOGTO_APP_SECRET: "test-logto-secret",
    SESSION_SECRET,
    PAAS_BASE_URL: "",
    MP_APPID: "wx-test-appid",
    MP_SECRET: "wx-test-secret",
    MP_TOKEN_SECRET: TOKEN_SECRET,
    MP_TOKEN_TTL_HOURS: "12",
    MP_JS_CODE_URL: `http://127.0.0.1:${mockPort}/sns/jscode2session`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let singleLog = "";
single.stdout.on("data", (b) => (singleLog += b));
single.stderr.on("data", (b) => (singleLog += b));

test("single-process: pair/challenge/login work sessionless; devices via session; config advertises", async () => {
  await waitFor(SP_PORT, "/api/config");
  const cfg = await fetch(`http://127.0.0.1:${SP_PORT}/api/config`).then((r) => r.json());
  assert.equal(cfg.capabilities?.devicePairing, true);

  const cookie = webCookie("sp-alpha@example.com", ["users"]);
  const device = freshDevice();
  const deviceId = "sp-device-1";

  const mint = await fetch(`http://127.0.0.1:${SP_PORT}/api/mp/bindcode`, {
    headers: { cookie, accept: "application/json" },
  });
  const { code } = await mint.json();

  // The three device endpoints are session-exempt (they authenticate through
  // the bind code / device key, like /api/mp/login before them).
  const pair = await post(SP_PORT, "/api/app/pair", { code, deviceId, pubkey: device.pubkey, label: "Android 16" });
  assert.equal(pair.status, 200);
  const ch = await post(SP_PORT, "/api/app/challenge", { deviceId });
  assert.equal(ch.status, 200);
  const { nonce } = await ch.json();
  const login = await post(SP_PORT, "/api/app/login", {
    deviceId,
    nonce,
    signature: signMessage(device.priv, `${deviceId}:${nonce}`),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const payload = verifyMpJwt(token, TOKEN_SECRET);
  assert.equal(payload.kind, "app");
  assert.equal(payload.did, deviceId);

  const list = await fetch(`http://127.0.0.1:${SP_PORT}/api/app/devices`, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).some((d) => d.deviceId === deviceId), true);

  // App-Bearer parity (found by the mobile app's integration smoke): the app
  // lists and unbinds ITSELF with its own token — the gateway's resolveUser
  // accepts it, and the single-process routes must too.
  const viaBearer = await fetch(`http://127.0.0.1:${SP_PORT}/api/app/devices`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(viaBearer.status, 200);
  assert.equal((await viaBearer.json()).some((d) => d.deviceId === deviceId), true);
  const selfRevoke = await fetch(`http://127.0.0.1:${SP_PORT}/api/app/bind/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(selfRevoke.status, 200);

  const revoke = await fetch(`http://127.0.0.1:${SP_PORT}/api/app/bind/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(revoke.status, 404, "already revoked by self — cookie path sees 404, not the other account's data");
  const after = await post(SP_PORT, "/api/app/challenge", { deviceId });
  assert.equal(after.status, 401);
});

test.after(async () => {
  if (single.exitCode !== null) return;
  const exited = new Promise((r) => single.once("exit", r));
  single.kill("SIGTERM");
  const timed = await Promise.race([
    exited.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 3000).unref()),
  ]);
  if (!timed) single.kill("SIGKILL");
});
