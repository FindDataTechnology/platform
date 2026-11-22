// Tests for the visitor-identity route (chatwoot-ai-handoff 5.x).
//
// The route's whole job is to NOT hand out an identity the widget cannot verify:
// an unsigned identifier lets anyone who learns it read that visitor's history.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHash, createHmac } from "node:crypto";
import { registerVisitorIdentityRoute } from "../server/routes/visitor-identity.js";

function makeApp({ bot } = {}) {
  const app = express();
  const ctx = {
    app,
    authEnabled: false,
    requireAdmin: () => true,
    db: { getBot: () => bot ?? null },
  };
  app.use(express.json());
  registerVisitorIdentityRoute(ctx);
  return app;
}

async function post(app, path, body) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

const bot = { id: "b1", type: "chatwoot", credentials: { widgetHmacToken: "wtok" } };

test("identity: mints a fresh id when none is supplied, with a verifiable hash", async () => {
  const app = makeApp({ bot });
  const { status, body } = await post(app, "/api/bots/b1/visitor-identity", {});
  assert.equal(status, 200);
  assert.match(body.visitorId, /^[0-9a-f]{32}$/);
  assert.equal(body.identifier, body.visitorId);
  const expected = createHmac("sha256", "wtok").update(body.visitorId).digest("hex");
  assert.equal(body.identifier_hash, expected);
});

test("identity: a well-formed id the browser already holds is honoured (same visitor, same id)", async () => {
  const app = makeApp({ bot });
  const held = createHash("sha256").update("x").digest("hex").slice(0, 32);
  const { body } = await post(app, "/api/bots/b1/visitor-identity", { visitorId: held });
  assert.equal(body.visitorId, held);
});

test("identity: a malformed supplied id is refused, never silently replaced", async () => {
  const app = makeApp({ bot });
  const { status } = await post(app, "/api/bots/b1/visitor-identity", { visitorId: "not-an-id" });
  assert.equal(status, 400);
});

test("identity: a bot with no hmac token refuses (an unsigned identity is forgeable)", async () => {
  const app = makeApp({ bot: { ...bot, credentials: {} } });
  const { status, body } = await post(app, "/api/bots/b1/visitor-identity", {});
  assert.equal(status, 409);
  assert.match(body.error, /no widgetHmacToken/);
});

test("identity: a non-chatwoot bot is refused", async () => {
  const app = makeApp({ bot: { id: "b2", type: "slack", credentials: {} } });
  const { status } = await post(app, "/api/bots/b2/visitor-identity", {});
  assert.equal(status, 400);
});

test("identity: an unknown bot is a 404", async () => {
  const app = makeApp({ bot: null });
  const { status } = await post(app, "/api/bots/nope/visitor-identity", {});
  assert.equal(status, 404);
});