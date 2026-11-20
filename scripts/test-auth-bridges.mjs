#!/usr/bin/env node
// ── Loopback bridge caller test (add-internal-bridge-identity-guard) ─────────
//
// Every in-cell MCP child reaches the platform over 127.0.0.1 with no session
// and no gateway secret, so loopback is its credential. The gate used to accept
// the ADDRESS alone for eight of ten bridges. In hosted mode the gateway proxies
// every real user into their cell from 127.0.0.1 while injecting
// x-forwarded-email (gateway/index.js:1107 + gateway/proxy.js:59), so a real
// user whose UI gesture lands on a bridge path was stamped with the bridge's
// machine identity. Two such paths are reachable from the web UI today:
//   POST /api/cron/:taskId/run   (fleet drawer's "run now")
//   POST /api/actions/propose    (board page's propose)
// and the second one is worse than a log cosmetic: server/routes/actions.js
// trusts `proposerEmail` from the body whenever req.user.internal is set, so a
// proxied human could propose as any address they named.
//
// The guard is now one predicate — loopback AND no x-forwarded-email — composed
// by every bridge in one table. This file pins both directions:
//   * the child (loopback, no identity headers) still bridges, on all ten;
//   * a proxied human (loopback + x-forwarded-email) never bridges, and is
//     authenticated as themselves instead;
//   * a non-loopback caller without headers never bridges.
//
//   node --test scripts/test-auth-bridges.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { internalBridgeEmail, registerAuth } from "../server/auth.js";

const SECRET = "cell-gateway-secret-for-test";

// One case per bridge entry: the verb/path the child uses and the identity the
// gate stamps for it. Keep in step with INTERNAL_BRIDGES in server/auth.js.
const BRIDGES = [
  { path: "/api/cron/abc/run", method: "POST", email: "cron@internal" },
  { path: "/api/cron", method: "GET", email: "cron@internal" },
  { path: "/api/resources/bind-declared", method: "POST", email: "chart-bridge@internal" },
  { path: "/api/delegation/tasks/1/manual", method: "POST", email: "delegation@internal" },
  { path: "/api/fleet-architect/draft", method: "POST", email: "fleet-architect@internal" },
  { path: "/api/blueprint-author/drafts", method: "POST", email: "builder-author@internal" },
  { path: "/api/pack-author/drafts", method: "POST", email: "builder-author@internal" },
  { path: "/api/skill-evolution/propose", method: "POST", email: "skill-evolution@internal" },
  { path: "/api/persona-evolution/propose", method: "POST", email: "persona-evolution@internal" },
  { path: "/api/resources/save-declared", method: "POST", email: "save-bridge@internal" },
  { path: "/api/actions/propose", method: "POST", email: "actions-bridge@internal" },
  { path: "/api/fleets/report", method: "POST", email: "fleet-bridge@internal" },
  { path: "/api/fleets/dispatch", method: "POST", email: "fleet-bridge@internal" },
  { path: "/api/fleets/deputy/resolve", method: "POST", email: "fleet-bridge@internal" },
];

const fakeReq = (path, method, addr, headers = {}) => ({
  path,
  method,
  socket: { remoteAddress: addr },
  headers,
});

test("the child still bridges on every path (loopback, no identity headers)", () => {
  for (const bridge of BRIDGES) {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(
        internalBridgeEmail(fakeReq(bridge.path, bridge.method, addr)),
        bridge.email,
        `${bridge.method} ${bridge.path} from ${addr}`,
      );
    }
  }
});

test("a proxied human never bridges: loopback + x-forwarded-email keeps their identity", () => {
  for (const bridge of BRIDGES) {
    assert.equal(
      internalBridgeEmail(
        fakeReq(bridge.path, bridge.method, "127.0.0.1", { "x-forwarded-email": "alice@corp.com" }),
      ),
      null,
      `${bridge.method} ${bridge.path} must not take the bridge for a proxied user`,
    );
  }
});

test("a non-loopback caller never bridges, and non-bridge paths never bridge", () => {
  assert.equal(internalBridgeEmail(fakeReq("/api/cron/abc/run", "POST", "10.0.0.7")), null);
  assert.equal(internalBridgeEmail(fakeReq("/api/actions/propose", "POST", "10.0.0.7")), null);
  assert.equal(internalBridgeEmail(fakeReq("/api/packs", "GET", "127.0.0.1")), null);
  assert.equal(internalBridgeEmail(fakeReq("/api/cron", "GET", "127.0.0.1", {})), "cron@internal");
});

test("verb scoping still holds: a GET cannot take a POST-only bridge", () => {
  assert.equal(internalBridgeEmail(fakeReq("/api/actions/propose", "GET", "127.0.0.1")), null);
  assert.equal(internalBridgeEmail(fakeReq("/api/skill-evolution/propose", "GET", "127.0.0.1")), null);
  assert.equal(internalBridgeEmail(fakeReq("/api/fleets/report", "GET", "127.0.0.1")), null);
});

// ── Through the real gate ───────────────────────────────────────────────────
// The table test above proves the predicate. This proves the gate: in hosted
// forward_auth mode, the same loopback socket either takes the bridge or is
// authenticated from the gateway's identity headers — never both.
function bootGate() {
  const app = express();
  app.use(express.json());
  const ctx = {
    app,
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    logtoAuth: null,
    headerTrust: { secret: SECRET },
    db: null,
  };
  registerAuth(ctx);
  app.post("/api/actions/propose", (req, res) =>
    res.json({ email: req.user?.email ?? null, internal: req.user?.internal === true }),
  );
  app.post("/api/cron/:id/run", (req, res) =>
    res.json({ email: req.user?.email ?? null, internal: req.user?.internal === true }),
  );
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

const gatewayHeaders = (email) => ({
  "content-type": "application/json",
  "x-cloud-gateway-secret": SECRET,
  "x-forwarded-email": email,
  "x-forwarded-groups": "creators",
});

test("through the gate: a proxied human keeps their own identity on a bridge path", async () => {
  const { server, base } = await bootGate();
  try {
    for (const path of ["/api/actions/propose", "/api/cron/t1/run"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: gatewayHeaders("alice@corp.com"),
        body: JSON.stringify({ proposerEmail: "victim@corp.com" }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, `${path} must be authenticated, not rejected`);
      assert.equal(body.email, "alice@corp.com", `${path}: the owner's identity, not the bridge's`);
      assert.equal(body.internal, false, `${path}: never stamped internal for a proxied human`);
    }
  } finally {
    server.close();
  }
});

test("through the gate: the header-less child still takes the bridge", async () => {
  const { server, base } = await bootGate();
  try {
    const actions = await fetch(`${base}/api/actions/propose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposerEmail: "owner@corp.com" }),
    });
    assert.deepEqual(await actions.json(), { email: "actions-bridge@internal", internal: true });

    const cron = await fetch(`${base}/api/cron/t1/run`, { method: "POST" });
    assert.deepEqual(await cron.json(), { email: "cron@internal", internal: true });
  } finally {
    server.close();
  }
});

test("through the gate: identity headers without the gateway secret stay unauthenticated", async () => {
  const { server, base } = await bootGate();
  try {
    const res = await fetch(`${base}/api/actions/propose`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-email": "alice@corp.com" },
      body: JSON.stringify({ proposerEmail: "victim@corp.com" }),
    });
    assert.equal(res.status, 401, "a spoofed identity header is not a bridge and not a login");
  } finally {
    server.close();
  }
});
