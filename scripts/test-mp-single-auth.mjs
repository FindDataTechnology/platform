// Integration test for the mini-program identity path on the SINGLE-PROCESS
// server (openspec: miniprogram-auth + add-single-process-mp-auth). Boots the
// REAL server.js with AUTH_MODE=logto, a mock WeChat code2Session upstream and
// a mock Logto discovery endpoint, then exercises the same bind-code contract
// the gateway test (test-mp-auth.mjs) covers, plus what is single-process
// specific: the login endpoints answer WITHOUT a browser session, the boot
// probe (/api/auth/me) reports mode:"logto" while /api/config stays public
// (browser pre-login), Bearer tokens carry the same standing as a cookie on
// REST and the WS upgrade, and the openid⇄account binding survives a process
// restart via PLATFORM_DATA_DIR. MP-unset inertness is covered at the
// composition level (second boot) and unit level (unconfigured createMpAuth).
// Runs under `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "../server/session.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Mock WeChat code2Session + Logto discovery/JWKS (one upstream) ───────────
const CODES = new Map([
  ["good-code", { openid: "o-SINGLE-111" }],
  ["renewed-good", { openid: "o-SINGLE-111" }], // same user, new code
  ["another-good", { openid: "o-SINGLE-222" }],
  ["used-code", { errcode: 40029, errmsg: "invalid code" }],
]);

let mockPortSelf = 0;
const mockUpstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  // Logto discovery + JWKS: server.js's Logto browser path fetches these at
  // boot. No test drives the browser flow, but boot requires them.
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
  if (code || url.searchParams.get("appid")) {
    assert.equal(url.searchParams.get("grant_type"), "authorization_code");
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

// ── The server under test ────────────────────────────────────────────────────
const TOKEN_SECRET = "test-mp-token-secret";
const SESSION_SECRET = "test-session-secret";
const scratch = mkdtempSync(path.join(tmpdir(), "mp-single-"));
const dataDir = path.join(scratch, "data");
const dshHome = path.join(scratch, "dsh");
const PORT = 3000 + Math.floor(Math.random() * 2000);

function bootServer() {
  const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      PLATFORM_DATA_DIR: dataDir,
      // A throwaway dsh home: the dsh child is irrelevant to these routes
      // (listen-first serves them while the agent initializes in background).
      DSH_HOME: dshHome,
      MCP_CONFIG_PATH: path.join(dataDir, "mcp.json"),
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
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));

  async function stop() {
    if (child.exitCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const timed = await Promise.race([
      exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 3000).unref()),
    ]);
    if (!timed) child.kill("SIGKILL");
    await exited;
  }

  return { child, log, stop };
}

const first = bootServer();

// Wait for the LISTEN, not for /api/ready: the dsh agent initializes in the
// background and these routes never touch it.
async function waitForListen() {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/config`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server.js never started listening:\n${first.log}`);
}
await waitForListen();

const api = (p, init) => fetch(`http://127.0.0.1:${PORT}${p}`, init);
const login = (code) =>
  api("/api/mp/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
const loginBindCode = (code, bindCode) =>
  api("/api/mp/login-bindcode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, bindCode }),
  });

// Mint a session cookie exactly like the browser Logto callback does.
function webSessionCookie(email, groups) {
  const ttlMs = 60 * 60 * 1000;
  const payload = { email, groups, exp: Math.floor((Date.now() + ttlMs) / 1000) };
  return sessionCookie("paas_session", payload, SESSION_SECRET, ttlMs).split(";")[0];
}

test.after(async () => {
  mockUpstream.closeAllConnections?.();
  mockUpstream.close();
  await first.stop();
});

// ── Boot probe contract (what the mini program sees before any login) ────────

test("probe: /api/auth/me reports mode logto; /api/config stays public", async () => {
  const me = await api("/api/auth/me");
  assert.equal(me.status, 200, "identity endpoint answers anonymously (the boot probe)");
  const body = await me.json();
  assert.equal(body.mode, "logto");
  assert.equal(body.authenticated, false, "no cookie → not authenticated");

  const cfg = await api("/api/config");
  assert.equal(cfg.status, 200, "config stays public — the web SPA fetches it pre-login");
});

// ── Login endpoints answer without any browser session ───────────────────────

test("unbound openid → 404 binding_required (no session required)", async () => {
  const r = await login("good-code");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "binding_required");
});

test("login: invalid/replayed code → 401, missing code → 400", async () => {
  assert.equal((await login("used-code")).status, 401);
  assert.equal(
    (
      await api("/api/mp/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
  );
});

// ── Bind-code minting (web side) ──────────────────────────────────────────────

const aliceCookie = webSessionCookie("alice@corp.com", ["acme", "admin"]);

test("bindcode requires an authenticated session", async () => {
  assert.equal((await api("/api/mp/bindcode", { headers: { accept: "application/json" } })).status, 401);
});

let aliceBindCode = "";

test("signed-in web session gets a 6-digit code (json + human page)", async () => {
  const r = await api("/api/mp/bindcode", { headers: { cookie: aliceCookie, accept: "application/json" } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.code, /^\d{6}$/);
  assert.equal(body.ttlMs, 5 * 60 * 1000);
  aliceBindCode = body.code;

  const html = await api("/api/mp/bindcode", { headers: { cookie: aliceCookie, accept: "text/html" } });
  assert.equal(html.status, 200);
  const page = await html.text();
  assert.ok(/\d{6}/.test(page), "the human page shows a 6-digit code");
  assert.ok(page.includes("alice@corp.com"), "the page names the account");
});

// ── First sign-in (bind-code redemption) + persistence location ──────────────

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

test("the binding persists in the deployment's data dir, gateway file format", () => {
  const file = path.join(dataDir, "data", "mp-bindings.json");
  assert.ok(existsSync(file), `expected bindings at ${file}`);
});

test("after binding, the silent path issues tokens with the account identity", async () => {
  const r = await login("renewed-good");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).email, aliceEmail);
});

test("a redeemed bind code is single-use — replay is rejected and binds nothing", async () => {
  const minted = await api("/api/mp/bindcode", { headers: { cookie: aliceCookie, accept: "application/json" } }).then((r) => r.json());
  assert.equal((await loginBindCode("another-good", minted.code)).status, 200);
  const replay = await loginBindCode("another-good", minted.code);
  assert.equal(replay.status, 401);
  assert.equal((await login("another-good")).status, 200, "the FIRST redemption bound this openid");
});

test("wrong or malformed bind codes are rejected without side effects", async () => {
  assert.equal((await loginBindCode("renewed-good", "999999")).status, 401);
  assert.equal((await loginBindCode("renewed-good", "abc12")).status, 400);
  assert.equal((await loginBindCode("renewed-good", "")).status, 400);
  // The bound openid still logs in silently — rejections bound nothing new.
  assert.equal((await login("renewed-good")).status, 200);
});

// ── Bearer identity standing (REST) ──────────────────────────────────────────

test("Bearer token authenticates a protected route with the account identity", async () => {
  const me = await api("/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.email, aliceEmail);
  assert.deepEqual(body.groups, ["acme", "admin"]);
});

test("anonymous protected route → 401 (no login redirect)", async () => {
  assert.equal((await api("/api/catalog")).status, 401);
});

test("Bearer token reaches a protected route the anonymous call cannot", async () => {
  const r = await api("/api/catalog", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
});

test("forged token → 401", async () => {
  const forged = `${token.slice(0, -4)}AAAA`;
  assert.equal((await api("/api/catalog", { headers: { authorization: `Bearer ${forged}` } })).status, 401);
});

test("expired token → 401", async () => {
  const { signMpJwt } = await import("../gateway/mp-auth.js");
  const expired = signMpJwt({ sub: "o-SINGLE-111", email: aliceEmail, iat: 1, exp: 2 }, TOKEN_SECRET);
  assert.equal((await api("/api/catalog", { headers: { authorization: `Bearer ${expired}` } })).status, 401);
});

// ── WebSocket upgrade gate ────────────────────────────────────────────────────

function wsUpgrade(auth) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: PORT,
      path: "/",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        ...(auth ? { authorization: auth } : {}),
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
}

test("WebSocket upgrade authenticates with the Bearer token", async () => {
  assert.ok(await wsUpgrade(`Bearer ${token}`), "upgrade should be accepted with the platform token");
});

test("WebSocket upgrade without a token is refused", async () => {
  assert.ok(!(await wsUpgrade(undefined)), "anonymous upgrade must be refused");
});

// ── Binding survives a restart, then logout (single-process persistence) ─────

test("restart with the same data dir: silent login still works; logout unbinds", async () => {
  await first.stop();
  const second = bootServer();
  try {
    await waitForListen();
    const r = await login("renewed-good");
    assert.equal(r.status, 200, "binding survived the restart");
    assert.equal((await r.json()).email, aliceEmail);

    const out = await api("/api/mp/bind", { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    assert.equal(out.status, 200);
    assert.equal((await login("renewed-good")).status, 404, "after logout the silent path asks for a bind code again");
  } finally {
    await second.stop();
  }
});

// ── Degradation: MP credentials unset (composition level) ─────────────────────

test("MP-unset boot: login endpoints report not-configured, browser paths unchanged", async () => {
  const PORT2 = 3000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT2),
      HOST: "127.0.0.1",
      PLATFORM_DATA_DIR: path.join(scratch, "data-mp-unset"),
      DSH_HOME: dshHome,
      MCP_CONFIG_PATH: path.join(scratch, "data-mp-unset", "mcp.json"),
      LLM_API_KEY: "",
      AUTH_MODE: "logto",
      LOGTO_ENDPOINT: `http://127.0.0.1:${mockPort}`,
      LOGTO_APP_ID: "test-logto-app",
      LOGTO_APP_SECRET: "test-logto-secret",
      SESSION_SECRET,
      PAAS_BASE_URL: "",
      // No MP_APPID / MP_SECRET / MP_TOKEN_SECRET.
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log2 = "";
  child.stdout.on("data", (b) => (log2 += b));
  child.stderr.on("data", (b) => (log2 += b));
  const api2 = (p, init) => fetch(`http://127.0.0.1:${PORT2}${p}`, init);
  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      try {
        up = (await api2("/api/config")).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(up, `server never started listening:\n${log2}`);

    const loginRes = await api2("/api/mp/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "good-code" }),
    });
    assert.equal(loginRes.status, 503);
    assert.match((await loginRes.json()).error, /not configured/i);

    const bindRes = await api2("/api/mp/login-bindcode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "good-code", bindCode: "123456" }),
    });
    assert.equal(bindRes.status, 503);

    assert.equal((await api2("/api/config")).status, 200, "browser pre-login config unaffected");
    const me = await api2("/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal((await me.json()).mode, "logto");

    // And no token could have verified anyway: a protected route stays 401.
    assert.equal((await api2("/api/catalog")).status, 401);
  } finally {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500).unref())]);
  }
});

// ── Degradation: MP credentials unset (unit level, shared module contract) ───

test("unconfigured createMpAuth reports not-configured (unit-level)", async () => {
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
  assert.equal(unconfigured.verifyToken("whatever"), null, "no token verifies when unconfigured");
});
