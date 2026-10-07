// Integration test for the mini-program identity path (openspec:
// miniprogram-auth + cell-gateway delta). Boots the REAL gateway with a mock
// WeChat code2Session upstream and a stub cell, then exercises the
// BIND-CODE contract: the web session (Logto cookie) mints a 6-digit code at
// /api/mp/bindcode, the mini program redeems it once with a wx.login code,
// the openid⇄account binding persists, later launches are silent, wrong or
// reused codes are rejected, logout unbinds, Bearer tokens route to the
// ACCOUNT's cell, and forged/expired tokens never reach a cell. Runs under
// `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "../server/session.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Mock WeChat code2Session ─────────────────────────────────────────────────
const CODES = new Map([
  ["good-code", { openid: "o-ALPHA-111" }],
  ["renewed-good", { openid: "o-ALPHA-111" }], // same user, new code
  ["another-good", { openid: "o-BETA-222" }],
  ["third-good", { openid: "o-GAMMA-333" }],
  ["used-code", { errcode: 40029, errmsg: "invalid code" }],
]);

let codeRequests = 0;
let mockPortSelf = 0;
const mockUpstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  // Logto discovery + JWKS: the gateway fetches these at boot for the
  // BROWSER path. No test drives the browser flow, but they must exist.
  if (req.method === "GET" && url.pathname.endsWith("/.well-known/openid-configuration")) {
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
  if (req.method === "GET" && url.pathname.endsWith("/jwks")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [] }));
    return;
  }

  const code = url.searchParams.get("js_code") ?? "";
  const appid = url.searchParams.get("appid") ?? "";
  if (code || appid) {
    assert.equal(url.searchParams.get("grant_type"), "authorization_code");
    assert.ok(appid && url.searchParams.get("secret"), "appid/secret must reach code2Session");
    codeRequests++;
    const body = CODES.get(code) ?? { errcode: -1, errmsg: `unknown code ${code}` };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
    return;
  }
  res.statusCode = 404;
  res.end();
});
mockUpstream.on("listening", () => (mockPortSelf = mockUpstream.address().port));
await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
const mockPort = mockPortSelf;

// ── The gateway under test ──────────────────────────────────────────────────
const GATEWAY_PORT = 3000 + Math.floor(Math.random() * 2000);
const TOKEN_SECRET = "test-mp-token-secret";
const SESSION_SECRET = "test-session-secret";
const GATEWAY_SECRET = "test-cell-gateway-secret";
const dataRoot = mkdtempSync(path.join(tmpdir(), "mp-auth-cells-"));
const gateway = spawn(process.execPath, ["gateway/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    GATEWAY_PORT: String(GATEWAY_PORT),
    GATEWAY_HOST: "127.0.0.1",
    CELL_GATEWAY_SECRET: GATEWAY_SECRET,
    CELL_DATA_ROOT: dataRoot,
    CELL_SERVER_ENTRY: path.join(REPO, "scripts/mp-stub-cell.mjs"),
    CELL_START_TIMEOUT_MS: "15000",
    MP_APPID: "wx-test-appid",
    MP_SECRET: "wx-test-secret",
    MP_TOKEN_SECRET: TOKEN_SECRET,
    MP_TOKEN_TTL_HOURS: "12",
    MP_JS_CODE_URL: `http://127.0.0.1:${mockPort}/sns/jscode2session`,
    SESSION_SECRET,
    AUTH_MODE: "logto",
    LOGTO_ENDPOINT: `http://127.0.0.1:${mockPort}`,
    LOGTO_APP_ID: "test-logto-app",
    LOGTO_APP_SECRET: "test-logto-secret",
    PAAS_BASE_URL: "",
    CELL_IDLE_REAP_SECS: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gatewayLog = "";
gateway.stdout.on("data", (b) => (gatewayLog += b));
gateway.stderr.on("data", (b) => (gatewayLog += b));

async function waitForGateway() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway never became healthy:\n${gatewayLog}`);
}
await waitForGateway();

const gw = (p, init) => fetch(`http://127.0.0.1:${GATEWAY_PORT}${p}`, init);
const login = (code) =>
  gw("/api/mp/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
const loginBindCode = (code, bindCode) =>
  gw("/api/mp/login-bindcode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, bindCode }),
  });

// Mint a gateway session cookie exactly like the browser callback does.
function webSessionCookie(email, groups) {
  const ttlMs = 60 * 60 * 1000;
  const payload = { email, groups, exp: Math.floor((Date.now() + ttlMs) / 1000) };
  return sessionCookie("paas_session", payload, SESSION_SECRET, ttlMs).split(";")[0];
}

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

// ── Silent path ──────────────────────────────────────────────────────────────

test("unbound openid → 404 binding_required (the login-page signal)", async () => {
  const r = await login("good-code");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "binding_required");
});

test("login: invalid/replayed code → 401, missing code → 400", async () => {
  assert.equal((await login("used-code")).status, 401);
  assert.equal(
    (
      await gw("/api/mp/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
  );
});

// ── Bind-code minting (web side) ────────────────────────────────────────────

const aliceCookie = webSessionCookie("alice@corp.com", ["acme", "admin"]);

test("bindcode requires an authenticated web session", async () => {
  assert.equal((await gw("/api/mp/bindcode", { headers: { accept: "application/json" } })).status, 401);
});

let aliceBindCode = "";

test("authenticated web session gets a 6-digit code (json + human page)", async () => {
  const r = await gw("/api/mp/bindcode", { headers: { cookie: aliceCookie, accept: "application/json" } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.code, /^\d{6}$/);
  assert.equal(body.ttlMs, 5 * 60 * 1000);
  aliceBindCode = body.code;

  // Browsers get the human-readable page with ITS OWN fresh code (each GET
  // mints a new one) naming the account.
  const html = await gw("/api/mp/bindcode", { headers: { cookie: aliceCookie, accept: "text/html" } });
  assert.equal(html.status, 200);
  const page = await html.text();
  assert.ok(/\d{6}/.test(page), "the human page shows a 6-digit code");
  assert.ok(page.includes("alice@corp.com"), "the page names the account");
});

// ── First sign-in (bind-code redemption) ────────────────────────────────────

let token = "";
const aliceEmail = "alice@corp.com";

test("redeeming the code binds openid⇄account and returns the account identity", async () => {
  const r = await loginBindCode("good-code", aliceBindCode);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.email, aliceEmail);
  assert.ok(body.token.split(".").length === 3);
  token = body.token;
});

test("after binding, the silent path issues tokens with the account identity", async () => {
  const r = await login("renewed-good"); // same openid (o-ALPHA-111), new code
  assert.equal(r.status, 200);
  assert.equal((await r.json()).email, aliceEmail);
});

test("a redeemed bind code is single-use — replay is rejected and binds nothing", async () => {
  // Mint a fresh code, redeem it once (GAMMA's openid), then try to replay it
  // against another openid.
  const minted = await gw("/api/mp/bindcode", { headers: { cookie: aliceCookie, accept: "application/json" } }).then((r) => r.json());
  assert.equal((await loginBindCode("third-good", minted.code)).status, 200);
  const replay = await loginBindCode("another-good", minted.code);
  assert.equal(replay.status, 401);
  // The replayed openid (BETA) stays unbound:
  assert.equal((await login("another-good")).status, 404);
});

test("wrong or malformed bind codes are rejected without side effects", async () => {
  assert.equal((await loginBindCode("another-good", "000000")).status, 401);
  assert.equal((await loginBindCode("another-good", "abc12")).status, 400);
  assert.equal((await loginBindCode("another-good", "")).status, 400);
  assert.equal((await login("another-good")).status, 404, "still unbound");
});

// ── Bearer-authenticated routing (account identity → the web user's cell) ───

test("Bearer token routes to the ACCOUNT's cell with verified identity + groups", async () => {
  const r = await gw("/api/config", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.stub, true, "response must come from the stub cell");
  assert.equal(body.email, aliceEmail);
  assert.equal(body.groups, "acme,admin");
  assert.equal(body.hasGatewaySecret, true);
});

test("forged token → 401, cell never contacted", async () => {
  const forged = `${token.slice(0, -4)}AAAA`;
  assert.equal((await gw("/api/config", { headers: { authorization: `Bearer ${forged}` } })).status, 401);
});

test("expired token → 401", async () => {
  const { signMpJwt } = await import("../gateway/mp-auth.js");
  const expired = signMpJwt({ sub: "o-ALPHA-111", email: aliceEmail, iat: 1, exp: 2 }, TOKEN_SECRET);
  assert.equal((await gw("/api/config", { headers: { authorization: `Bearer ${expired}` } })).status, 401);
});

test("client-supplied identity headers are stripped alongside a valid token", async () => {
  const r = await gw("/api/config", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-email": "attacker@example.com",
      "x-forwarded-groups": "admin",
      "x-cloud-gateway-secret": "spoof",
    },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.email, aliceEmail, "cell sees only the verified identity");
  assert.equal(body.groups, "acme,admin");
  assert.equal(body.hasGatewaySecret, true, "real gateway secret, not the spoof");
});

test("anonymous programmatic request → 401 (no login redirect)", async () => {
  assert.equal((await gw("/api/config")).status, 401);
});

test("WebSocket upgrade authenticates with the Bearer token", async () => {
  const ok = await new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: GATEWAY_PORT,
      path: "/",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        authorization: `Bearer ${token}`,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.end();
      resolve(res.statusCode === 101 || res.headers.upgrade === "websocket");
    });
    req.on("response", (res) => {
      res.resume();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
  assert.ok(ok, "upgrade should complete via the gateway to the stub cell");
});

test("WebSocket upgrade without a token is refused", async () => {
  const refused = await new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: GATEWAY_PORT,
      path: "/",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode === 401);
    });
    req.on("upgrade", () => resolve(false));
    req.on("error", () => resolve(false));
    req.end();
  });
  assert.ok(refused, "anonymous upgrade must get a 401");
});

// ── Identity model ───────────────────────────────────────────────────────────

test("a second account binds to its own cell; accounts never share", async () => {
  const { userIdFor } = await import("../gateway/spawner.js");
  const bobCookie = webSessionCookie("bob@corp.com", []);
  const minted = await gw("/api/mp/bindcode", { headers: { cookie: bobCookie, accept: "application/json" } }).then((r) => r.json());
  const bob = await loginBindCode("another-good", minted.code).then((r) => r.json());
  assert.equal(bob.email, "bob@corp.com");
  assert.notEqual(userIdFor(bob.email), userIdFor(aliceEmail), "distinct accounts → distinct cells");
});

// ── Logout ───────────────────────────────────────────────────────────────────

test("logout removes the binding; the next silent login asks for a bind code again", async () => {
  const r = await gw("/api/mp/bind", { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  assert.equal((await login("renewed-good")).status, 404);
});

// ── Degradation ──────────────────────────────────────────────────────────────

test("unconfigured deployment reports not-configured (unit-level)", async () => {
  const { createMpAuth } = await import("../gateway/mp-auth.js");
  const bindingsStub = {
    load: async () => {},
    get: () => null,
    set: async () => {},
    remove: async () => {},
    issueBindCode: () => {
      throw new Error("must not be reached");
    },
    consumeBindCode: () => null,
  };
  const unconfigured = createMpAuth({
    appid: "",
    mpSecret: "",
    tokenSecret: "",
    ttlHours: 12,
    codeUrl: `http://127.0.0.1:${mockPort}/sns/jscode2session`,
    bindings: bindingsStub,
  });
  assert.equal((await unconfigured.login("good-code")).status, 503);
  assert.equal((await unconfigured.loginWithBindCode("good-code", "123456")).status, 503);
  assert.equal(unconfigured.verifyToken(token), null, "no token verifies when unconfigured");
  assert.equal(codeRequests, 11, "unconfigured must not add code2Session calls (11 from prior logins)");
});
