// fd-bot→cell subscription lane (adopt-fd-bot-transport 6.1): the binding
// lifecycle, the body-peek gateway forward, and the cell's path-param form.
//
//   node --test scripts/test-fd-bot-binding-lane.mjs

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { test } from "node:test";
import express from "express";

// ── 1. ensureFdBotBinding: the POST body, and the id flowing to the row ──────
//
// ORDER MATTERS (test-store-override-ordering): db.js binds DB_PATH at module
// evaluation (db.js:20). A static `import ... from "../gateway/proxy.js"`
// would be hoisted above the DB_PATH assignment and pull db.js in through the
// import chain first, so the suite would run against the real data dir instead
// of the temp one. Every module that can reach db.js is imported dynamically,
// after the environment is set.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fd-bot-binding-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.FD_BOT_URL = "http://fd-bot.test";
process.env.FD_BOT_SECRET = "mgmt-secret";
process.env.BOTS_EVENTS_TOKEN = "events-token";

const { proxyBufferedBody, readBodyBounded } = await import("../gateway/proxy.js");
const db = await import("../db.js");
const { ensureFdBotBinding } = await import("../lib/fd-bot-binding.js");
await db.initDb();

const newBot = () =>
  db.addBot({
    id: `bot-${Math.random().toString(36).slice(2)}`,
    type: "slack",
    name: "binder",
    credentials: { botToken: "xoxb-live", signingSecret: "ss" },
    secret: "s3cret",
    enabled: true,
    ownerEmail: "owner@test.local",
  });

test("ensureFdBotBinding posts the binding and stores the returned id", async () => {
  const bot = newBot();
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(JSON.stringify({ id: "b_created_1" }), { status: 200 });
  };
  const updated = await ensureFdBotBinding({
    bot,
    publicBaseUrl: "https://platform.example.com/",
    fetchImpl,
  });
  assert.equal(seen.url, "http://fd-bot.test/v1/bindings");
  assert.equal(seen.auth, "Bearer mgmt-secret");
  assert.equal(seen.body.platform, "slack");
  assert.equal(seen.body.subscriberUrl, "https://platform.example.com/api/bots/events", "id-free subscriber path, trailing slash normalized");
  assert.equal(seen.body.deliveryToken, "events-token");
  assert.equal(seen.body.label, bot.id);
  assert.deepEqual(seen.body.credentials, { botToken: "xoxb-live", signingSecret: "ss" });
  assert.equal(updated.transport, "fd-bot");
  assert.equal(updated.fdBotBindingId, "b_created_1");
});

test("an fd-bot refusal leaves the row on legacy and never throws", async () => {
  const bot = newBot();
  const fetchImpl = async () => new Response("bad platform", { status: 400 });
  const updated = await ensureFdBotBinding({ bot, publicBaseUrl: "https://p.example", fetchImpl });
  assert.equal(updated.transport, null);
  assert.equal(updated.fdBotBindingId, null);
});

test("no PUBLIC_BASE_URL → nothing is created, the row stays legacy", async () => {
  const bot = newBot();
  let called = false;
  const updated = await ensureFdBotBinding({
    bot,
    publicBaseUrl: null,
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });
  assert.equal(called, false);
  assert.equal(updated, null);
});

// ── 2. the body-peek forward: exact bytes + authorization preserved ──────────

function withCell(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("proxyBufferedBody forwards the exact body bytes and the caller's authorization", async () => {
  let got = null;
  const cell = await withCell((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const app = express();
    // No body parser: the route must read the raw stream itself.
    app.all("/api/bots/events", async (req, res) => {
      const body = await readBodyBounded(req);
      proxyBufferedBody(req, res, body, {
        host: "127.0.0.1",
        port: cell.address().port,
        headers: { "content-type": req.headers["content-type"], authorization: req.headers.authorization, "x-cloud-gateway-secret": "gw" },
      });
    });
    const gw = await withCell(app);
    try {
      const raw = '{"bindingId":"b_1","text":"héllo ✓","n":1}'; // non-ASCII on purpose
      const r = await fetch(`http://127.0.0.1:${gw.address().port}/api/bots/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer events-token" },
        body: raw,
      });
      assert.equal(r.status, 200);
      assert.equal(got.body.toString("utf8"), raw, "the cell must see the exact bytes fd-bot sent");
      assert.equal(got.headers.authorization, "Bearer events-token", "the cell re-verifies the token itself");
      assert.equal(got.headers["content-length"], String(Buffer.byteLength(raw)));
      assert.equal(got.url, "/api/bots/events");
    } finally {
      gw.close();
    }
  } finally {
    cell.close();
  }
});

test("readBodyBounded rejects an oversized envelope instead of buffering it", async () => {
  const app = express();
  app.post("/big", async (req, res) => {
    try {
      await readBodyBounded(req, 16);
      res.end("no");
    } catch (err) {
      res.status(err.code === "TOO_LARGE" ? 413 : 400).end(err.code);
    }
  });
  const srv = await withCell(app);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/big`, { method: "POST", body: "x".repeat(64) });
    assert.equal(r.status, 413);
  } finally {
    srv.close();
  }
});

// ── 3. the cell route honors a :bindingId path param ─────────────────────────

test("the cell route takes the binding id from the path when present", async () => {
  const { registerBotEventRoutes } = await import("../server/routes/bot-events.js");
  const bot = db.addBot({
    id: `bot-${Math.random().toString(36).slice(2)}`,
    type: "slack",
    name: "pathbot",
    credentials: { botToken: "x", signingSecret: "ss" },
    secret: "s",
    enabled: true,
    ownerEmail: "owner@test.local",
  });
  db.setBotTransport(bot.id, "fd-bot", "b_path");

  const calls = [];
  const app = express();
  registerBotEventRoutes({
    app,
    db,
    botTurnRunner: async (botId, args) => calls.push({ botId, ...args }),
  });
  const srv = await withCell(app);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/bots/events/b_path`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer events-token" },
      // The body's bindingId is a DECOY — the path wins.
      body: JSON.stringify({ bindingId: "b_wrong", chatKey: "c", text: "hi" }),
    });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].botId, bot.id);
  } finally {
    srv.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
