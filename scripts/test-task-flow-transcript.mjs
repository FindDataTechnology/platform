#!/usr/bin/env node
// ── Card transcript read face (make-task-flow-board-live 5.1/5.2)
//
// The drawer that shows "what this card actually said" reads THIS endpoint, not
// `/api/chat-history/sessions/:id`. The reason is a real failure mode, not a
// preference: the cron runner records task turns without an owner, and
// `chatHistory.accessSession` admits a NULL-owner row only to an admin — so the
// natural path 403s the card's own owner under auth. That case is the second
// test below and it is the one this whole endpoint exists for.
//
// Four branches, each with its own scenario in the spec:
//   owner reads / stranger 404s / never-dispatched has no transcript /
//   a read error degrades the PANEL, not the card (always HTTP 200).
//
//   node --test scripts/test-task-flow-transcript.mjs

import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "flow-transcript-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const engine = await import("../task-engine.js");
const { registerFlowRoutes } = await import("../server/routes/flows.js");
const { createTaskFlowDatabase } = await import("../server/task-flow-db.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const openServers = new Set();
test.afterEach(() => {
  for (const s of openServers) {
    try { s.close(); } catch { /* already closed */ }
  }
  openServers.clear();
});

let seq = 0;
const freshFlow = () => {
  seq += 1;
  return {
    flowId: `content-${seq}`,
    name: `内容生产 ${seq}`,
    stations: [{ stationId: "draft", label: "起草", target: { kind: "persona", ref: "writer" }, acceptance: [] }],
  };
};

// `fakeHistory` stands in for chat-history.js: the real module needs SQLite
// rows that these tests would have to bootstrap. The endpoint's contract with
// it is one call — `getSession(id)` — so the fake pins exactly that seam.
const harness = async ({ authEnabled, fakeHistory }) => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const taskFlowDatabase = createTaskFlowDatabase({ file: path.join(tmpRoot, `flows-${Math.random().toString(36).slice(2)}.db`) });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.headers["x-test-user"];
    const groups = String(req.headers["x-test-groups"] ?? "").split(",").filter(Boolean);
    req.user = who ? { email: String(who), groups } : null;
    next();
  });
  const ctx = {
    app,
    taskFlowDatabase,
    authEnabled,
    isAdminUser: (u) => Boolean(u?.groups?.includes?.("admin")),
    flowExists: { persona: () => true, a2a: () => true, cluster: () => true },
    chatHistory: fakeHistory,
  };
  registerFlowRoutes(ctx, {});
  const server = app.listen(0, "127.0.0.1");
  openServers.add(server);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(user ? { "x-test-user": user } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call };
};

const mkCard = async (h, flow, owner) => {
  const put = await h.call(owner, "PUT", `/api/flows/${flow.flowId}`, flow);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const created = await h.call(owner, "POST", `/api/flows/${flow.flowId}/cards`, { prompt: "写一份周报" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.card;
};

test("5.1 the card's owner can read its transcript", async () => {
  const fakeHistory = {
    getSession: async (id) => ({ id, title: "t", messages: [{ role: "user", content: "Q" }, { role: "assistant", content: "A" }] }),
  };
  const h = await harness({ authEnabled: true, fakeHistory });
  const flow = freshFlow();
  const card = await mkCard(h, flow, "alice@example.com");

  const r = await h.call("alice@example.com", "GET", `/api/flows/cards/${card.id}/transcript`);
  assert.equal(r.status, 200);
  assert.equal(r.body.exists, true);
  assert.deepEqual(r.body.messages, [
    { role: "user", content: "Q" },
    { role: "assistant", content: "A" },
  ]);
});

test("5.2 auth on + a NULL-owner task session: the card owner still reads it (the 403 this endpoint prevents)", async () => {
  // The fake mirrors the real store's shape: a session row with NO owner. If
  // the drawer read `/api/chat-history/sessions/:id`, accessSession would refuse
  // this caller. Reading through the card must not.
  const fakeHistory = {
    getSession: async (id) => ({ id, messages: [{ role: "assistant", content: "done" }] }),
    // Present to make the point explicit: this is what the session REST gate
    // would have answered.
    accessSession: () => ({ ok: false, reason: "forbidden" }),
  };
  const h = await harness({ authEnabled: true, fakeHistory });
  const flow = freshFlow();
  const card = await mkCard(h, flow, "alice@example.com");

  const r = await h.call("alice@example.com", "GET", `/api/flows/cards/${card.id}/transcript`);
  assert.equal(r.status, 200, "the card's own owner must not be blocked by session ownership");
  assert.equal(r.body.exists, true);
  assert.equal(r.body.messages.length, 1);
});

test("5.1 a stranger cannot read someone else's card transcript", async () => {
  const fakeHistory = { getSession: async (id) => ({ id, messages: [{ role: "user", content: "SECRET" }] }) };
  const h = await harness({ authEnabled: true, fakeHistory });
  const flow = freshFlow();
  const card = await mkCard(h, flow, "alice@example.com");

  const r = await h.call("bob@example.com", "GET", `/api/flows/cards/${card.id}/transcript`);
  assert.equal(r.status, 404, "not-yours is reported the same way as not-found");
  assert.ok(!JSON.stringify(r.body).includes("SECRET"));
});

test("5.1 a never-dispatched card reports no transcript, not an error", async () => {
  const fakeHistory = { getSession: async () => null };
  const h = await harness({ authEnabled: true, fakeHistory });
  const flow = freshFlow();
  const card = await mkCard(h, flow, "alice@example.com");

  const r = await h.call("alice@example.com", "GET", `/api/flows/cards/${card.id}/transcript`);
  assert.equal(r.status, 200);
  assert.equal(r.body.exists, false);
  assert.deepEqual(r.body.messages, []);
});

test("5.1 a transcript read failure degrades the panel, not the card (HTTP 200 + readError)", async () => {
  const fakeHistory = { getSession: async () => { throw new Error("db is on fire"); } };
  const h = await harness({ authEnabled: true, fakeHistory });
  const flow = freshFlow();
  const card = await mkCard(h, flow, "alice@example.com");

  const r = await h.call("alice@example.com", "GET", `/api/flows/cards/${card.id}/transcript`);
  assert.equal(r.status, 200, "a 5xx here would take the card's four verbs down with it");
  assert.equal(r.body.exists, false);
  assert.match(r.body.readError, /db is on fire/);
});

test("5.1 auth off (single user) reads any card's transcript", async () => {
  const fakeHistory = { getSession: async (id) => ({ id, messages: [{ role: "user", content: "hi" }] }) };
  const h = await harness({ authEnabled: false, fakeHistory });
  const flow = freshFlow();
  const card = await mkCard(h, flow, null);

  const r = await h.call(null, "GET", `/api/flows/cards/${card.id}/transcript`);
  assert.equal(r.status, 200);
  assert.equal(r.body.exists, true);
});
