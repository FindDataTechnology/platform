import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeUpgrade, userForConnection } from "../server/ws.js";
import { signSession } from "../server/session.js";

const user = { email: "user@example.com", groups: ["admin"] };

test("Logto WebSocket upgrade accepts valid and rejects missing or invalid sessions", () => {
  const secret = "secret";
  const valid = signSession({ ...user, exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const ctx = {
    authMode: "logto",
    logtoAuth: {
      userFromCookie: (cookie) => {
        const match = cookie?.match(/paas_session=([^;]+)/);
        return match ? (match[1] === valid ? user : null) : null;
      },
    },
  };

  assert.equal(authorizeUpgrade(ctx, { headers: { cookie: `paas_session=${valid}` } }), true);
  assert.equal(authorizeUpgrade(ctx, { headers: { cookie: "" } }), false);
  assert.equal(authorizeUpgrade(ctx, { headers: { cookie: "paas_session=invalid" } }), false);
});

test("Logto WebSocket identity is fixed from the upgrade cookie", () => {
  const cookie = "paas_session=valid";
  const ctx = {
    authMode: "logto",
    authEnabled: true,
    ssoEnabled: false,
    logtoAuth: { userFromCookie: (value) => value === cookie ? user : null },
  };

  assert.deepEqual(userForConnection(ctx, { headers: { cookie } }), user);
  assert.equal(userForConnection(ctx, { headers: { cookie: "" } }), null);
});

test("open auth mode keeps WebSocket access anonymous", () => {
  const ctx = { authMode: "none", logtoAuth: null };
  assert.equal(authorizeUpgrade(ctx, { headers: {} }), true);
  assert.equal(userForConnection(ctx, { headers: {} }), null);
});
