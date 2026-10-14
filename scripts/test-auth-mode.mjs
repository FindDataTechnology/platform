import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";
import { registerAuth, userFromHeaders } from "../server/auth.js";
import { signSession } from "../server/session.js";

function request(app, path = "/", headers = {}, method = "GET") {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
    server.on("error", reject);
  });
}

function expressApp(ctx) {
  const app = express();
  ctx.app = app;
  registerAuth(ctx);
  const echo = (req, res) => res.json({ user: req.user || null });
  app.get("/protected", echo);
  app.get("/api/auth/me", echo);
  // A genuinely protected route: /api/* other than /api/auth/me is never
  // "public" in the forward-auth gate, so this is where a 401 is observable.
  app.get("/api/private", echo);
  // An exempt route, the machine-caller convention: no identity required
  // because it carries its own authentication (the bot relay's bearer token).
  app.post("/api/bots/relay/send", (_req, res) => res.json({ reached: true }));
  return app;
}

test("logto ignores forged identity headers and accepts a signed cookie", async () => {
  const secret = "secret";
  const cookie = signSession({ email: "user@example.com", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const ctx = {
    authMode: "logto",
    authEnabled: true,
    ssoEnabled: false,
    logtoAuth: {
      userFromCookie: (value) => value === `paas_session=${cookie}` ? { email: "user@example.com", groups: ["admin"] } : null,
      authenticate: (req, res) => {
        const user = ctx.logtoAuth.userFromCookie(req.headers.cookie);
        if (user) res.setHeader("Set-Cookie", "refreshed=1");
        return user;
      },
    },
  };
  const anonymous = await request(expressApp(ctx), "/protected", { accept: "text/html", "x-forwarded-email": "forged@example.com" });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.location, "/login");

  const authenticated = await request(expressApp(ctx), "/protected", { cookie: `paas_session=${cookie}` });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(JSON.parse(authenticated.body).user, { email: "user@example.com", groups: ["admin"] });
});

test("forward_auth preserves proxy email casing", () => {
  assert.deepEqual(userFromHeaders({ "x-forwarded-email": "User@Example.COM", "x-forwarded-groups": "users" }), {
    email: "User@Example.COM",
    groups: ["users"],
  });
});

// ── Hosted-cell identity trust (CLOUD_MODE + CELL_GATEWAY_SECRET) ────────────

function forwardAuthCtx(trust) {
  return { authMode: "forward_auth", authEnabled: true, ssoEnabled: false, headerTrust: trust };
}

const IDENTITY = { "x-forwarded-email": "user@example.com", "x-forwarded-groups": "admin" };

test("hosted cell honors identity headers carrying the gateway secret", async () => {
  const app = expressApp(forwardAuthCtx({ secret: "s3cret" }));
  const res = await request(app, "/api/private", { ...IDENTITY, "x-cloud-gateway-secret": "s3cret" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).user, { email: "user@example.com", groups: ["admin"] });
});

test("hosted cell treats identity headers without the secret as absent", async () => {
  const app = expressApp(forwardAuthCtx({ secret: "s3cret" }));
  const res = await request(app, "/api/private", IDENTITY);
  assert.equal(res.status, 401);
});

test("hosted cell rejects a wrong gateway secret without echoing the identity", async () => {
  const app = expressApp(forwardAuthCtx({ secret: "s3cret" }));
  const res = await request(app, "/api/private", { ...IDENTITY, "x-cloud-gateway-secret": "guess" });
  assert.equal(res.status, 401);
});

test("hosted cell with no configured secret trusts no identity headers", async () => {
  const app = expressApp(forwardAuthCtx({ secret: "" }));
  const res = await request(app, "/api/private", { ...IDENTITY, "x-cloud-gateway-secret": "" });
  assert.equal(res.status, 401);
});

test("gate is inert outside hosted mode (headerTrust null)", async () => {
  const app = expressApp(forwardAuthCtx(null));
  const res = await request(app, "/api/private", IDENTITY);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).user, { email: "user@example.com", groups: ["admin"] });
});

// ── Exempt paths (machine callers) ───────────────────────────────────────────

test("the relay path is exempt in both auth modes while /api stays identity-gated", async () => {
  // forward_auth: no identity headers at all.
  const faApp = expressApp(forwardAuthCtx(null));
  const faRelay = await request(faApp, "/api/bots/relay/send", {}, "POST");
  assert.equal(faRelay.status, 200);
  assert.equal(JSON.parse(faRelay.body).reached, true);
  assert.equal((await request(faApp, "/api/private")).status, 401);

  // logto: no session cookie — the interactive path cannot serve a machine.
  const loApp = expressApp({
    authMode: "logto",
    authEnabled: true,
    ssoEnabled: false,
    logtoAuth: { authenticate: () => null },
  });
  const loRelay = await request(loApp, "/api/bots/relay/send", {}, "POST");
  assert.equal(loRelay.status, 200);
  assert.equal(JSON.parse(loRelay.body).reached, true);
  assert.equal((await request(loApp, "/api/private")).status, 401);
});
