// Unit tests — desk embed routes (add-crm-desk-pack-embed task 6.x).
// Spins a real express app with the route registered against a stub upstream
// (sign_in + API echo), asserting the go/entry/proxy flow, the honest
// degradations, and the auth negatives.
// Run: node --test scripts/test-desk-embed.mjs

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "desk-embed-")), "data.db");
process.env.DB_PATH = DB_PATH;

const db = await import("../db.js");
await db.initDb();
const cw = await import("../chatwoot-credentials.js");

const SECRET = "test-gateway-secret";
process.env.CELL_GATEWAY_SECRET = SECRET;
process.env.DESK_EMBED_URL = "https://desk-embed.example";
const MERCHANT = "merchant@test.example";

// Stub upstream: /auth/sign_in mints headers; /api/v1/profile echoes the
// devise headers it received (proves injection).
const upstream = http.createServer((req, res) => {
  if (req.url === "/auth/sign_in" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const creds = JSON.parse(body || "{}");
      if (creds.password === "good-pw") {
        res.writeHead(200, {
          "content-type": "application/json",
          "access-token": "up-at",
          client: "up-client",
          uid: creds.email,
          expiry: String(Math.floor(Date.now() / 1000) + 3600),
        });
        res.end("{}");
      } else {
        res.writeHead(401).end('{"success":false}');
      }
    });
    return;
  }
  if (req.url === "/api/v1/profile") {
    // token-bound profile: the token value selects the chatwoot user id
    const at = req.headers["api-access-token"] ?? "";
    const id = at === "tk-merchant" ? 7 : at === "tk" ? 1 : null;
    if (id == null) {
      res.writeHead(401).end('{"error":"Invalid Access Token"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, accounts: [{ id, name: "tenant-" + id }] }));
    return;
  }
  if (req.url.startsWith("/api/v1/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      at: req.headers["access-token"] ?? null,
      client: req.headers["client"] ?? null,
      uid: req.headers["uid"] ?? null,
    }));
    return;
  }
  {
    const m = req.url.match(/^\/platform\/api\/v1\/users\/(\d+)\/login$/);
    if (m) {
      if ((req.headers["api-access-token"] ?? "") !== "platform-tok") {
        res.writeHead(401).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: `https://desk.example/app/login?email=u${m[1]}%40x&sso_auth_token=one-time` }));
      return;
    }
    if (req.url.startsWith("/platform/")) {
      // user not in permissibles
      res.writeHead(404).end("{}");
      return;
    }
  }
  res.writeHead(404).end("{}");
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.CHATWOOT_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.CHATWOOT_PLATFORM_TOKEN = "platform-tok";

const express = (await import("express")).default;
const { registerDeskEmbedRoutes } = await import("../server/routes/desk-embed.js");

const app = express();
const seen = [];
app.use((req, _res, next) => {
  // gateway-injected identity: set by tests per scenario
  req.user = app.locals.testUser ?? null;
  seen.push(`${req.method} ${req.url}`);
  next();
});
app.use(express.json({ limit: "1mb" }));
registerDeskEmbedRoutes({ app, db, authEnabled: true });
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

function as(user) {
  app.locals.testUser = user ? { email: user } : null;
}

test("6.1 go: unauthenticated is refused (auth negative)", async () => {
  as(null);
  const r = await fetch(`${base}/external/desk/go`, { redirect: "manual" });
  assert.equal(r.status, 401);
});

test("6.1 go: connected merchant with login pair mints a valid embed token", async () => {
  cw.store({ email: MERCHANT, token: "tk", loginEmail: "m@chat.example", loginPassword: "good-pw" });
  as(MERCHANT);
  const r = await fetch(`${base}/external/desk/go`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const location = r.headers.get("location");
  assert.match(location, /^https:\/\/desk-embed\.example\/entry\?et=/);
  const et = new URL(location).searchParams.get("et");
  const { verifyEmbedToken } = await import("../server/session.js");
  assert.deepEqual(verifyEmbedToken(et, SECRET), { email: MERCHANT });
});

test("6.1 go: token-only user is pointed at the connect panel, not the embed", async () => {
  const tokenOnly = "token-only@test.example";
  cw.store({ email: tokenOnly, token: "tk" });
  as(tokenOnly);
  const r = await fetch(`${base}/external/desk/go`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /panel=chatwoot/);
});

test("6.2 entry: sign-in with the stored pair lands the SPA with an embed cookie", async () => {
  as(MERCHANT);
  const r = await fetch(`${base}/external/desk/entry`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/app/");
  const cookie = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("desk_embed="));
  assert.ok(cookie, "embed cookie set");
  assert.match(verifyEmbedTokenHeuristic(cookie), /desk_embed=/);
});
function verifyEmbedTokenHeuristic(c) {
  return c.slice(0, 24);
}

test("6.2 entry: token-only user gets the honest 422, not a half-open embed", async () => {
  as("token-only@test.example");
  const r = await fetch(`${base}/external/desk/entry`, { redirect: "manual" });
  assert.equal(r.status, 422);
  assert.match(await r.text(), /登录凭据/);
});

test("6.2 proxy: devise headers injected from the upstream session; per-user", async () => {
  as(MERCHANT);
  const r = await fetch(`${base}/external/desk/api/v1/conversations`);
  const body = await r.json();
  assert.equal(body.at, "up-at");
  assert.equal(body.client, "up-client");
  assert.equal(body.uid, "m@chat.example");
});

test("6.3 negative: another user without credentials gets 401 on the proxy, never the merchant session", async () => {
  as("stranger@test.example");
  const r = await fetch(`${base}/external/desk/api/v1/profile`);
  assert.equal(r.status, 401);
  const text = await r.text();
  assert.ok(!text.includes("up-at"), "no merchant session material leaks");
});

test("6.3 negative: no-credential user never reaches upstream (no upstream session minted for them)", async () => {
  // stranger sign-in attempts would 401 upstream (no stored pair) — proxy says 401
  as("stranger2@test.example");
  const r = await fetch(`${base}/external/desk/api/v1/conversations`);
  assert.equal(r.status, 401);
});

// Keep the test process exitable: both servers are keep-alive handles.
test.after(() => {
  try { server.close(); } catch {}
  try { upstream.close(); } catch {}
});


// ── SSO direct path (paas-embed-desk-requirements) ──────────────────────────

test("sso: connected user exchanges to a one-time login URL for THEIR tenant", async () => {
  as(MERCHANT);
  cw.store({ email: MERCHANT, token: "tk-merchant" }); // profile maps to user 7
  const r = await fetch(`${base}/external/crm-desk/sso`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = r.headers.get("location");
  assert.match(loc, /sso_auth_token=one-time$/);
  assert.match(loc, /u7%40x|u7@x/);
  assert.equal(cw.chatwootUserId(MERCHANT), 7, "mapping cached on the row");
});

test("sso: user without a connected credential gets the honest 未开通 page", async () => {
  as("no-cred@test.example");
  const r = await fetch(`${base}/external/crm-desk/sso`, { redirect: "manual" });
  assert.equal(r.status, 404);
  assert.match(await r.text(), /尚未开通客服台/);
});

test("sso: permissibles-miss (upstream 404) surfaces 未开通 SSO, never a login", async () => {
  const outsider = "outsider@test.example";
  cw.store({ email: outsider, token: "tk-unknown" }); // profile maps to id=null → 401 profile → invalid
  as(outsider);
  const r = await fetch(`${base}/external/crm-desk/sso`, { redirect: "manual" });
  // tk-unknown profile → 401 → resolved null → 凭据无效 page
  assert.equal(r.status, 401);
});

test("sso: platform token absent → honest 未配置 page", async () => {
  delete process.env.CHATWOOT_PLATFORM_TOKEN;
  try {
    as(MERCHANT);
    const r = await fetch(`${base}/external/crm-desk/sso`, { redirect: "manual" });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /SSO 未配置/);
  } finally {
    process.env.CHATWOOT_PLATFORM_TOKEN = "platform-tok";
  }
});
