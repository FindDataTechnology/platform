// Tests for the visitor-identity route (chatwoot-ai-handoff 5.x).
//
// Two properties, pulling opposite ways:
//   - reachable without a login (the visitor is anonymous), safe ONLY because
//   - it never signs an id it did not mint (otherwise the hash is worthless —
//     anyone could name any visitor and get a valid signature).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import { registerVisitorIdentityRoute } from "../server/routes/visitor-identity.js";

const BOT = {
  id: "b1",
  type: "chatwoot",
  credentials: { websiteToken: "WT", widgetHmacToken: "htok" },
};

function makeApp(bots = [BOT]) {
  const app = express();
  const ctx = { app, db: { listBots: () => bots } };
  app.use(express.json());
  registerVisitorIdentityRoute(ctx);
  return app;
}

async function post(app, body) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/widget/visitor-identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

const hmac = (id) => createHmac("sha256", "htok").update(id).digest("hex");

test("identity: first contact mints a fresh id with a verifiable hash", async () => {
  const { status, body } = await post(makeApp(), { websiteToken: "WT" });
  assert.equal(status, 200);
  assert.match(body.visitorId, /^[0-9a-f]{32}$/);
  assert.equal(body.identifier, body.visitorId);
  assert.equal(body.identifier_hash, hmac(body.visitorId));
  assert.equal(body.minted, true);
});

test("identity: returning visitor is re-signed only when it proves the id (echoes the hash)", async () => {
  const id = "a".repeat(32);
  const { status, body } = await post(makeApp(), {
    websiteToken: "WT",
    visitorId: id,
    identifierHash: hmac(id),
  });
  assert.equal(status, 200);
  assert.equal(body.visitorId, id);
  assert.equal(body.identifier_hash, hmac(id));
  assert.equal(body.minted, false);
});

test("identity: naming an id WITHOUT its hash is refused — no oracle", async () => {
  // This is the property that makes the public endpoint safe: a caller cannot
  // ask the server to sign an arbitrary visitor id.
  const { status } = await post(makeApp(), { websiteToken: "WT", visitorId: "b".repeat(32) });
  assert.equal(status, 403);
});

test("identity: naming an id with a WRONG hash is refused, same shape as unknown", async () => {
  const wrong = await post(makeApp(), {
    websiteToken: "WT",
    visitorId: "c".repeat(32),
    identifierHash: "0".repeat(64),
  });
  const unknown = await post(makeApp(), { websiteToken: "WT", visitorId: "d".repeat(32) });
  assert.equal(wrong.status, 403);
  assert.equal(unknown.status, 403);
  assert.deepEqual(wrong.body, unknown.body, "must not reveal which ids exist");
});

test("identity: a malformed id is refused before any signing", async () => {
  const { status } = await post(makeApp(), { websiteToken: "WT", visitorId: "nope" });
  assert.equal(status, 400);
});

test("identity: unknown website token is a 404", async () => {
  const { status } = await post(makeApp(), { websiteToken: "other" });
  assert.equal(status, 404);
});

test("identity: a bot with no hmac token refuses (unsigned is forgeable)", async () => {
  const bots = [{ ...BOT, credentials: { websiteToken: "WT" } }];
  const { status, body } = await post(makeApp(bots), { websiteToken: "WT" });
  assert.equal(status, 409);
  assert.match(body.error, /no widgetHmacToken/);
});

test("identity: missing website token is a 400", async () => {
  const { status } = await post(makeApp(), {});
  assert.equal(status, 400);
});