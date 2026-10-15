// Unit tests — line-credentials (add-line-credential-refs).
// Run: node --test scripts/test-line-credentials.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "line-cred-")), "data.db");
process.env.DB_PATH = DB_PATH;

const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
await db.initDb();
const lc = await import("../line-credentials.js");

const EMAIL = "lines@test.example";

const idToken = (expOffsetSec, nonce) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({
    sub: "u1", email: EMAIL, exp: Math.floor(Date.now() / 1000) + expOffsetSec,
    ...(nonce ? { nonce } : {}),
  })).toString("base64url");
  return `${h}.${p}.sig`;
};

test("unknown line is rejected at store", () => {
  assert.equal(lc.store({ email: EMAIL, line: "nope", token: "x" }), null);
});

test("ID token line: store → live → expire → omit → 401 clears → browser re-mint recovers", () => {
  const status = lc.store({ email: EMAIL, line: "wire-customer", token: idToken(3600) });
  assert.equal(status.connected, true);
  assert.equal(typeof lc.liveToken(EMAIL, "wire-customer"), "string");

  // expired token ⇒ liveToken null (server omitted), but row remains
  db.setLineCredential({ email: EMAIL, line: "wire-customer",
    token: idToken(-60), tokenExp: Date.now() - 60_000, stale: 0 });
  assert.equal(lc.liveToken(EMAIL, "wire-customer"), null);
  assert.equal(lc.status(EMAIL, "wire-customer").connected, false);

  // 401 clears the cache; browser re-mint restores
  assert.equal(lc.markInvalid(EMAIL, "wire-customer"), true);
  const again = lc.store({ email: EMAIL, line: "wire-customer", token: idToken(3600) });
  assert.equal(again.connected, true);
  assert.equal(typeof lc.liveToken(EMAIL, "wire-customer"), "string");
});

test("ID token line: stale is never set (re-mint, not re-paste)", () => {
  lc.store({ email: EMAIL, line: "lex", token: idToken(3600) });
  assert.equal(lc.markInvalid(EMAIL, "lex"), true); // cleared
  const s = lc.status(EMAIL, "lex");
  assert.equal(s.stale, false); // stale semantics NOT used for ID-token lines
  assert.equal(lc.markInvalid(EMAIL, "lex"), false); // nothing to clear
});

test("wanxing-caller: sk- paste, 401 flips stale once, re-paste recovers", () => {
  assert.equal(lc.store({ email: EMAIL, line: "wanxing-caller", token: "sk-abc123" }).connected, true);
  assert.equal(typeof lc.liveToken(EMAIL, "wanxing-caller"), "string");
  assert.equal(lc.markInvalid(EMAIL, "wanxing-caller"), true);
  assert.equal(lc.markInvalid(EMAIL, "wanxing-caller"), false);
  assert.equal(lc.liveToken(EMAIL, "wanxing-caller"), null);
  assert.equal(lc.status(EMAIL, "wanxing-caller").stale, true);
  assert.equal(lc.store({ email: EMAIL, line: "wanxing-caller", token: "sk-fresh" }).connected, true);
  assert.equal(lc.status(EMAIL, "wanxing-caller").stale, false);
});

test("projections never carry the token", () => {
  lc.store({ email: EMAIL, line: "wanxing-caller", token: "sk-secret-value" });
  const s = JSON.stringify(lc.status(EMAIL, "wanxing-caller"));
  assert.ok(!s.includes("sk-secret-value"));
});

test("credential-refs knows all three refs and forwards per line", async () => {
  const refs = await import("../credential-refs.js");
  for (const ref of ["wire-customer", "lex", "wanxing-caller"]) {
    assert.equal(refs.knownRef(ref), true);
    const entry = refs.refFor({ credentialRef: ref });
    assert.equal(entry.refName, ref);
  }
  // wire ref resolves the wire-customer line's token
  const entry = refs.refFor({ credentialRef: "wire-customer" });
  assert.equal(typeof entry.liveToken(EMAIL), "string");
});

// ── Server-mediated mint (the production fix: full-page round trip) ──────────
//
// The browser popup path could never work (cross-origin location reads throw
// SecurityError; wire's auth/config has no CORS). The mint now runs entirely
// server-side: start → Logto → callback on THIS origin → code→token exchange.

import express from "express";
import { createServer } from "node:http";
import { registerLineCredentialRoutes } from "../server/routes/line-credentials.js";

function httpRequest(app, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const payload = body ? JSON.stringify(body) : null;
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { ...(payload ? { "content-type": "application/json" } : {}), ...headers },
        body: payload,
        redirect: "manual",
      })
        .then(async (res) => {
          const text = await res.text();
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null; // redirect bodies ("Found. Redirecting to …") are not JSON
          }
          server.close(() =>
            resolve({
              status: res.status,
              location: res.headers.get("location"),
              setCookie: res.headers.get("set-cookie"),
              body,
            }),
          );
        })
        .catch((e) => {
          server.close(() => reject(e));
        });
    });
  });
}

function mintCtx(overrides = {}) {
  const ctx = {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: false,
    logtoAuth: null,
    PAAS_BASE_URL: "https://platform.test",
    resolveSessionSecret: async () => "test-session-secret",
    ...overrides,
  };
  registerAuth(ctx);
  ctx.dshUpdateMcpCalls = [];
  ctx.dshUpdateMcp = (overlay, groups, ownerEmail) => {
    ctx.dshUpdateMcpCalls.push({ overlay, groups, ownerEmail });
    return Promise.resolve();
  };
  ctx.runtimeMcpOverlay = {};
  registerLineCredentialRoutes({ ...ctx, db });
  return ctx;
}

const ADMIN = { "x-forwarded-email": "admin@x.test", "x-forwarded-groups": "admin" };

test("mint/start redirects to Logto with PKCE + prompt=none and a signed state cookie", async () => {
  let sawConfig = null;
  const ctx = mintCtx({
    lineMintTargets: { "wire-customer": { configUrl: "https://wire.test/auth/config" } },
    fetchImpl: async (url) => {
      if (String(url).includes("/auth/config")) {
        sawConfig = String(url);
        return new Response(
          JSON.stringify({
            configured: true,
            issuer: "https://auth.test",
            client_id: "wire-spa",
            scopes: ["openid", "profile", "email", "offline_access"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const res = await httpRequest(ctx.app, "GET", "/api/lines/wire-customer/mint/start", { headers: ADMIN });
  assert.equal(res.status, 302, "redirects to the authorize endpoint");
  const url = new URL(res.location);
  assert.equal(url.origin + url.pathname, "https://auth.test/oidc/auth");
  assert.equal(url.searchParams.get("client_id"), "wire-spa");
  assert.equal(url.searchParams.get("prompt"), "none", "silent first");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://platform.test/api/lines/wire-customer/mint/callback",
    "callback lives on THIS origin — no cross-origin read anywhere",
  );
  assert.ok(!url.searchParams.get("scope").includes("offline_access"), "offline_access dropped");
  assert.match(res.setCookie, /paas_line_mint=/, "signed state cookie set");
  assert.ok(sawConfig.includes("wire.test"), "config read server-side (no browser CORS)");
});

test("mint/callback exchanges the code server-side, stores, and lands on /settings/mcp", async () => {
  const tokenCalls = [];
  let start;
  const ctx = mintCtx({
    lineMintTargets: { lex: { configUrl: "https://lex.test/auth/config" } },
    fetchImpl: async (url, options) => {
      if (String(url).includes("/auth/config")) {
        return new Response(
          JSON.stringify({ configured: true, issuer: "https://auth.test", client_id: "lex-spa", scopes: ["openid"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("/oidc/token")) {
        tokenCalls.push({ url: String(url), body: options.body.toString() });
        // Echo the nonce from the authorize request (OIDC requires it back).
        const nonce = new URL(start.location).searchParams.get("nonce");
        return new Response(JSON.stringify({ id_token: idToken(3600, nonce) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  start = await httpRequest(ctx.app, "GET", "/api/lines/lex/mint/start", { headers: ADMIN });
  const state = new URL(start.location).searchParams.get("state");
  const cookie = start.setCookie.split(";")[0];

  const cb = await httpRequest(
    ctx.app,
    "GET",
    `/api/lines/lex/mint/callback?code=authcode1&state=${state}`,
    { headers: { ...ADMIN, cookie } },
  );
  assert.equal(cb.status, 302);
  assert.equal(cb.location, "/settings/mcp?tab=market", "lands back on the connect cards");
  assert.equal(tokenCalls.length, 1, "server exchanged the code");
  assert.ok(tokenCalls[0].body.includes("grant_type=authorization_code"));
  assert.ok(tokenCalls[0].body.includes("code_verifier="), "PKCE verifier sent (no client secret)");
  assert.equal(lc.status("admin@x.test", "lex").connected, true, "stored under the caller's identity");
  assert.equal(ctx.dshUpdateMcpCalls.length, 1, "profile re-applied once");
  assert.match(cb.setCookie, /paas_line_mint=;/, "state cookie cleared");
});

test("mint/callback rejects a nonce mismatch (token not issued for this request)", async () => {
  lc.disconnect("admin@x.test", "lex"); // isolate from the successful-exchange test
  const ctx = mintCtx({
    lineMintTargets: { lex: { configUrl: "https://lex.test/auth/config" } },
    fetchImpl: async (url) => {
      if (String(url).includes("/auth/config")) {
        return new Response(
          JSON.stringify({ configured: true, issuer: "https://auth.test", client_id: "lex-spa", scopes: ["openid"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).includes("/oidc/token")) {
        // A token for a DIFFERENT authorize request: nonce does not match.
        return new Response(JSON.stringify({ id_token: idToken(3600, "someone-elses-nonce") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const start = await httpRequest(ctx.app, "GET", "/api/lines/lex/mint/start", { headers: ADMIN });
  const state = new URL(start.location).searchParams.get("state");
  const cookie = start.setCookie.split(";")[0];
  const cb = await httpRequest(
    ctx.app,
    "GET",
    `/api/lines/lex/mint/callback?code=authcode1&state=${state}`,
    { headers: { ...ADMIN, cookie } },
  );
  assert.match(cb.location, /lineError=lex$/, "nonce mismatch fails closed");
  assert.equal(lc.status("admin@x.test", "lex").connected, false, "nothing stored");
});

test("mint/callback rejects a state mismatch and never echoes upstream bodies", async () => {
  const ctx = mintCtx({
    lineMintTargets: { lex: { configUrl: "https://lex.test/auth/config" } },
    fetchImpl: async (url) => {
      if (String(url).includes("/auth/config")) {
        return new Response(
          JSON.stringify({ configured: true, issuer: "https://auth.test", client_id: "lex-spa", scopes: ["openid"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("must not reach the token endpoint");
    },
  });
  const start = await httpRequest(ctx.app, "GET", "/api/lines/lex/mint/start", { headers: ADMIN });
  const cookie = start.setCookie.split(";")[0];
  const cb = await httpRequest(ctx.app, "GET", "/api/lines/lex/mint/callback?code=x&state=forged", {
    headers: { ...ADMIN, cookie },
  });
  assert.equal(cb.status, 302);
  assert.match(cb.location, /^\/settings\/mcp\?tab=market&lineError=lex$/);
});

test("mint/callback retries once interactively on login_required, then gives up", async () => {
  const ctx = mintCtx({
    lineMintTargets: { "wire-customer": { configUrl: "https://wire.test/auth/config" } },
    fetchImpl: async (url) => {
      if (String(url).includes("/auth/config")) {
        return new Response(
          JSON.stringify({ configured: true, issuer: "https://auth.test", client_id: "wire-spa", scopes: ["openid"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const start = await httpRequest(ctx.app, "GET", "/api/lines/wire-customer/mint/start", { headers: ADMIN });
  const state = new URL(start.location).searchParams.get("state");
  const cookie = start.setCookie.split(";")[0];
  const cb = await httpRequest(
    ctx.app,
    "GET",
    `/api/lines/wire-customer/mint/callback?error=login_required&state=${state}`,
    { headers: { ...ADMIN, cookie } },
  );
  assert.equal(cb.status, 302);
  assert.equal(
    cb.location,
    "/api/lines/wire-customer/mint/start?interactive=1",
    "exactly one interactive retry",
  );

  // The interactive start drops prompt=none so the user can consent.
  const retry = await httpRequest(ctx.app, "GET", "/api/lines/wire-customer/mint/start?interactive=1", {
    headers: ADMIN,
  });
  assert.equal(new URL(retry.location).searchParams.get("prompt"), null, "interactive leg carries no prompt=none");

  // A second failure on the interactive leg is final.
  const state2 = new URL(retry.location).searchParams.get("state");
  const cookie2 = retry.setCookie.split(";")[0];
  const cb2 = await httpRequest(
    ctx.app,
    "GET",
    `/api/lines/wire-customer/mint/callback?error=login_required&state=${state2}`,
    { headers: { ...ADMIN, cookie: cookie2 } },
  );
  assert.match(cb2.location, /tab=market&lineError=wire-customer$/);
});

test("mint routes 404 unknown lines and 401 anonymous hosted callers", async () => {
  const ctx = mintCtx({
    lineMintTargets: { "wire-customer": { configUrl: "https://wire.test/auth/config" } },
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.equal((await httpRequest(ctx.app, "GET", "/api/lines/unknown/mint/start", { headers: ADMIN })).status, 404);
  assert.equal(
    (await httpRequest(ctx.app, "GET", "/api/lines/wire-customer/mint/start")).status,
    401,
    "anonymous hosted caller is rejected before any upstream call",
  );
  // The auth gate answers first for anonymous callers (401), so the route's
  // own 404 is asserted with an authenticated caller.
  assert.equal((await httpRequest(ctx.app, "GET", "/api/lines/unknown/mint/callback")).status, 401);
  assert.equal(
    (await httpRequest(ctx.app, "GET", "/api/lines/unknown/mint/callback", { headers: ADMIN })).status,
    404,
  );
});
