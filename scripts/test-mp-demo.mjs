// Integration test for mini-program demo mode (openspec: mp-demo-mode +
// miniprogram-auth/cell-gateway deltas). Three layers:
//
//   unit        — demoEmailFor derivation, createDemoBudget boundary, and the
//                 in-cell prompt cap driven through a minimal fake ctx;
//   gateway     — boots the REAL gateway (mock WeChat upstream, stub cell,
//                 MP_DEMO_MODE=1): unbound openids get demo tokens, demo users
//                 land in distinct cells, the pool cap answers a friendly 503,
//                 demo cells reap + delete while account cells stay resident,
//                 and a bind-code redemption upgrades a demo user;
//   wire format — none beyond the above (the demo path reuses the platform
//                 JWT and identity headers verbatim).
//
// Runs under `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "../server/session.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Unit: demo identity + budget ─────────────────────────────────────────────

test("unit: demoEmailFor is deterministic, opaque, and never collides with real accounts", async () => {
  const { demoEmailFor, DEMO_EMAIL_DOMAIN } = await import("../gateway/mp-auth.js");
  const a1 = demoEmailFor("o-REVIEWER-999");
  const a2 = demoEmailFor("o-REVIEWER-999");
  assert.equal(a1, a2, "same openid → same demo email");
  assert.match(a1, /^demo-[0-9a-f]{8}@demo\.invalid$/);
  assert.equal(DEMO_EMAIL_DOMAIN, "demo.invalid");
  assert.ok(!a1.includes("o-REVIEWER-999"), "the raw openid never appears in the email");
  assert.notEqual(a1, demoEmailFor("o-OTHER-888"), "distinct openids → distinct demo identities");
});

test("unit: createDemoBudget admits up to the limit for demo users, always for account users", async () => {
  const { createDemoBudget } = await import("../server/ws.js");
  const budget = createDemoBudget(2);
  const demo = { email: "demo-x@demo.invalid", groups: ["demo"] };
  const account = { email: "alice@corp.com", groups: ["acme"] };
  assert.equal(budget.take(demo), true);
  assert.equal(budget.take(demo), true);
  assert.equal(budget.take(demo), false, "third demo prompt is refused");
  assert.equal(budget.take(account), true, "account users never hit the demo budget");
  assert.equal(budget.take(null), true, "no identity (auth-less deployments) passes");
});

// ── Unit: the in-cell prompt cap, through a minimal fake ctx ─────────────────

test("unit: prompt #limit+1 gets the demo limit reply and starts no turn", async () => {
  process.env.MP_DEMO_MSG_LIMIT = "3";
  const { attachWebSocket, DEMO_LIMIT_REPLY } = await import("../server/ws.js");

  const broadcasts = [];
  const prompts = [];
  const replies = [];
  const ctx = {
    server: new EventEmitter(),
    wss: new EventEmitter(),
    clients: new Set(),
    authMode: "forward_auth", // identity from headers, exactly as a cell sees it
    ready: { dsh: true },
    isStreaming: false,
    promptStoppedByNavigation: false,
    currentAgentId: "local",
    dshSessionId: null,
    runtimeModel: null,
    session: {
      prompt: async () => {
        prompts.push(1);
        ctx.finishTurn();
      },
      // beginTurnFor's no-live-session path (add-session-ownership) adopts a
      // new session as this connection's view before prompting into it.
      sessionManager: { setSessionId: () => {} },
    },
    startNewSession: async (ws) => {
      const id = "mp-demo-test-session";
      if (ws) ws.viewedSession = id;
      return id;
    },
    getPermissionPresets: async () => ({ options: [], current: null }),
    switchableAgents: () => [],
    // The connect-time session list is scoped per connection (add-session-
    // ownership); forward_auth derives it from ws.user.
    sessionScopeFor: () => undefined,
    planMessage: () => ({ type: "plan", steps: [] }),
    remoteChatEntryFor: () => null,
    broadcast: (m) => broadcasts.push(m),
    // Turn fan-out is per-session now (add-session-ownership) — the user
    // echo rides it; feed it into the same capture the assertions read.
    sendToViewers: (_sid, m) => broadcasts.push(m),
    finishTurn: () => {
      ctx.isStreaming = false;
    },
  };
  attachWebSocket(ctx);

  // userForConnection (forward_auth) derives ws.user from the upgrade's
  // identity headers — the same path the gateway-injected headers take.
  const openWs = (email, groups) => {
    const ws = new EventEmitter();
    ws.readyState = 1; // OPEN
    ws.OPEN = 1;
    ws.send = (raw) => replies.push(JSON.parse(raw));
    ctx.wss.emit("connection", ws, {
      headers: { "x-forwarded-email": email, "x-forwarded-groups": groups },
    });
    return ws;
  };

  const demo = openWs("demo-x@demo.invalid", "demo");
  const send = (ws, text) => ws.emit("message", Buffer.from(JSON.stringify({ type: "prompt", text })));
  const settle = () => new Promise((r) => setTimeout(r, 20));

  for (let i = 1; i <= 3; i++) {
    send(demo, `question ${i}`);
    await settle();
  }
  assert.equal(prompts.length, 3, "the first three prompts start turns");
  assert.equal(broadcasts.filter((m) => m.type === "user").length, 3);

  send(demo, "question 4");
  await settle();
  assert.equal(prompts.length, 3, "prompt #4 starts no agent turn");
  assert.ok(
    replies.some((m) => m.type === "error" && m.message === DEMO_LIMIT_REPLY.message),
    "prompt #4 is answered with the demo limit reply",
  );

  // An account user on the same cell is never limited.
  const account = openWs("alice@corp.com", "acme");
  for (let i = 1; i <= 4; i++) {
    send(account, `real question ${i}`);
    await settle();
  }
  assert.equal(prompts.length, 7, "account prompts keep flowing past the demo limit");

  delete process.env.MP_DEMO_MSG_LIMIT;
});

// ── Mock WeChat code2Session ─────────────────────────────────────────────────

const CODES = new Map([
  ["demo-a1", { openid: "o-DEMO-AAA" }],
  ["demo-a2", { openid: "o-DEMO-AAA" }], // same user, new wx.login code
  ["demo-b", { openid: "o-DEMO-BBB" }],
  ["demo-c", { openid: "o-DEMO-CCC" }],
  ["upgrader-1", { openid: "o-UPGRADE-77" }],
  ["upgrader-2", { openid: "o-UPGRADE-77" }],
]);
let mockPortSelf = 0;
const mockUpstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
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
  if (code) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(CODES.get(code) ?? { errcode: -1, errmsg: `unknown code ${code}` }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
mockUpstream.on("listening", () => (mockPortSelf = mockUpstream.address().port));
await new Promise((r) => mockUpstream.listen(0, "127.0.0.1", r));
const mockPort = mockPortSelf;

// ── The demo-enabled gateway under test ──────────────────────────────────────

const GATEWAY_PORT = 5000 + Math.floor(Math.random() * 2000);
const TOKEN_SECRET = "test-mp-demo-token-secret";
const SESSION_SECRET = "test-mp-demo-session-secret";
const dataRoot = mkdtempSync(path.join(tmpdir(), "mp-demo-cells-"));
const gateway = spawn(process.execPath, ["gateway/index.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    GATEWAY_PORT: String(GATEWAY_PORT),
    GATEWAY_HOST: "127.0.0.1",
    CELL_GATEWAY_SECRET: "test-mp-demo-gateway-secret",
    CELL_DATA_ROOT: dataRoot,
    CELL_SERVER_ENTRY: path.join(REPO, "scripts/mp-stub-cell.mjs"),
    CELL_START_TIMEOUT_MS: "15000",
    CELL_IDLE_REAP_SECS: "0", // account cells stay resident — demo reap must be independent
    MP_APPID: "wx-test-appid",
    MP_SECRET: "wx-test-secret",
    MP_TOKEN_SECRET: TOKEN_SECRET,
    MP_TOKEN_TTL_HOURS: "12",
    MP_JS_CODE_URL: `http://127.0.0.1:${mockPort}/sns/jscode2session`,
    MP_DEMO_MODE: "1",
    MP_DEMO_MAX_CELLS: "2",
    MP_DEMO_IDLE_SECS: "3",
    SESSION_SECRET,
    AUTH_MODE: "logto",
    LOGTO_ENDPOINT: `http://127.0.0.1:${mockPort}`,
    LOGTO_APP_ID: "test-logto-app",
    LOGTO_APP_SECRET: "test-logto-secret",
    PAAS_BASE_URL: "",
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
const bearer = (token, p = "/api/config") => gw(p, { headers: { authorization: `Bearer ${token}` } });
const decode = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

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

// ── Demo login (identity only — no cell spawned) ─────────────────────────────

let demoAToken = "";
const _demoAEmail = "";

test("demo gateway: an unbound openid gets a demo-scoped token, deterministically", async () => {
  const r = await login("demo-a1");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.email, /^demo-[0-9a-f]{8}@demo\.invalid$/);
  const payload = decode(body.token);
  assert.equal(payload.sub, "o-DEMO-AAA");
  assert.equal(payload.email, body.email);
  assert.deepEqual(payload.groups, ["demo"]);
  demoAToken = body.token;

  // A later launch with a fresh wx.login code resolves to the same identity.
  const again = await login("demo-a2");
  assert.equal((await again.json()).email, body.email);
});

test("demo gateway: bind-code redemption upgrades a demo user to the real account", async () => {
  // The upgrader starts as a demo user…
  const asDemo = await login("upgrader-1");
  assert.match((await asDemo.json()).email, /^demo-/);

  // …then binds the account from an authenticated web session.
  const adminCookie = webSessionCookie("alice@corp.com", ["acme", "admin"]);
  const minted = await gw("/api/mp/bindcode", { headers: { cookie: adminCookie, accept: "application/json" } }).then((r) => r.json());
  const bound = await loginBindCode("upgrader-1", minted.code);
  assert.equal(bound.status, 200);
  assert.equal((await bound.json()).email, "alice@corp.com");

  // The next SILENT launch is the account, not the demo identity.
  const silent = await login("upgrader-2");
  assert.equal((await silent.json()).email, "alice@corp.com");
});

// ── Demo cells: isolation, cap, reap ─────────────────────────────────────────

test("demo cells: two demo users get distinct cells; the third meets a friendly 503", async () => {
  const a = await bearer(demoAToken).then((r) => r.json());
  assert.equal(a.stub, true);
  assert.equal(a.groups, "demo", "the cell sees the demo group via the identity headers");

  const b = await login("demo-b").then((r) => r.json());
  const bBody = await bearer(b.token).then((r) => r.json());
  assert.equal(bBody.groups, "demo");
  assert.notEqual(a.port, bBody.port, "each demo openid gets its own cell");

  const c = await login("demo-c").then((r) => r.json());
  const capRes = await bearer(c.token);
  assert.equal(capRes.status, 503);
  const capBody = await capRes.json();
  assert.equal(capBody.code, "demo_capacity");
  assert.ok(capBody.error.length > 0, "the capacity reply is friendly, not a raw spawn failure");

  // The rejected user spawned nothing: still exactly two demo cells.
  const adminCookie = webSessionCookie("alice@corp.com", ["acme", "admin"]);
  const status = await gw("/api/gateway/status", { headers: { cookie: adminCookie } }).then((r) => r.json());
  assert.equal(status.demoCells, 2, "the capped-out user must not spawn a cell");
});

test("demo reap: idle demo cells stop and delete their data; the account cell stays resident", async () => {
  const { userIdFor } = await import("../gateway/spawner.js");
  const adminCookie = webSessionCookie("alice@corp.com", ["acme", "admin"]);

  // An account cell must exist and stay up while demo cells are reaped
  // (CELL_IDLE_REAP_SECS=0 → account cells resident forever).
  const aliceToken = await login("upgrader-2").then((r) => r.json()).then((b) => b.token);
  assert.equal((await bearer(aliceToken)).status, 200);

  const demoDir = path.join(dataRoot, userIdFor(decode(demoAToken).email));
  const aliceDir = path.join(dataRoot, userIdFor("alice@corp.com"));
  assert.ok(existsSync(demoDir), "the demo cell's data root exists while running");

  // MP_DEMO_IDLE_SECS=3 and the reaper polls every 5s — poll status until the
  // demo cells are gone (bounded wait).
  let sawReaped = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await gw("/api/gateway/status", { headers: { cookie: adminCookie } }).then((r) => r.json());
    if (status.demoCells === 0) {
      sawReaped = true;
      const aliceCell = status.cells.find((c) => c.user === "alice@corp.com");
      assert.equal(aliceCell?.state, "running", "the account cell must survive demo reaping");
      break;
    }
  }
  assert.ok(sawReaped, "demo cells must be reaped after the demo idle window");
  assert.ok(!existsSync(demoDir), "the demo data root is deleted on reap");
  assert.ok(existsSync(aliceDir), "the account cell's data root is untouched by demo cleanup");

  // …and the demo user can cold-start a fresh cell afterwards.
  const fresh = await bearer(demoAToken);
  assert.equal(fresh.status, 200);
  assert.equal((await fresh.json()).groups, "demo");
});
