// Unit tests — zhiyu hatch export route (add-zhiyu-room, task group 2).
// Run: node --test scripts/test-zhiyu-export.mjs
//
//   1.x  window parsing: last:2 tails the transcript, all returns everything,
//        missing/malformed/out-of-range windows answer a readable 400.
//   2.x  gate: a foreign session is 403 and an unknown id is 404 — same shape
//        as the session get route; provenance fields (sessionId/title/window)
//        ride the payload.

import test from "node:test";
import assert from "node:assert/strict";

import { registerChatHistoryRoutes } from "../server/routes/chat-history.js";

function makeCtx({ user, sessions }) {
  // Minimal ctx: the real accessSession semantics compressed to fixtures —
  // the gate itself has its own coverage; what is under test here is the
  // export window logic riding behind it.
  const chatHistory = {
    accessSession(_user, id) {
      if (!(id in sessions)) return { ok: false, reason: "not_found" };
      if (sessions[id].owner !== user?.email) return { ok: false, reason: "forbidden" };
      return { ok: true };
    },
    async getSession(id) {
      const s = sessions[id];
      if (!s) return null;
      return { id, title: s.title, messages: s.messages };
    },
  };
  return {
    app: null, // set by caller
    chatHistory,
    authEnabled: true,
    isAdminUser: () => false,
    withTurnStatus: (x) => x,
  };
}

async function boot(sessions, userEmail = "owner@x") {
  const express = (await import("express")).default;
  const app = express();
  app.use((req, _res, next) => {
    req.user = { email: userEmail, groups: [] };
    next();
  });
  const ctx = makeCtx({ user: { email: userEmail }, sessions });
  ctx.app = app;
  registerChatHistoryRoutes(ctx);
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return srv;
}

const MESSAGES = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i + 1}` }));

test("1.1 window=last:2 returns the tail slice with provenance", async () => {
  const srv = await boot({ s1: { owner: "owner@x", title: "T", messages: MESSAGES } });
  const port = srv.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/chat-history/sessions/s1/export?window=last:2`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.sessionId, "s1");
  assert.equal(body.title, "T");
  assert.deepEqual(body.window, { kind: "last", n: 2 });
  assert.equal(body.totalMessages, 5);
  assert.deepEqual(body.messages.map((m) => m.content), ["m4", "m5"]);
  srv.close();
});

test("1.2 window=all returns the whole transcript", async () => {
  const srv = await boot({ s1: { owner: "owner@x", title: "T", messages: MESSAGES } });
  const port = srv.address().port;
  const body = await (await fetch(`http://127.0.0.1:${port}/api/chat-history/sessions/s1/export?window=all`)).json();
  assert.equal(body.messages.length, 5);
  srv.close();
});

test("1.3 missing / malformed / out-of-range window → readable 400", async () => {
  const srv = await boot({ s1: { owner: "owner@x", title: "T", messages: MESSAGES } });
  const port = srv.address().port;
  for (const q of ["", "?window=", "?window=last:0", "?window=last:1001", "?window=recent", "?window=last:abc"]) {
    const r = await fetch(`http://127.0.0.1:${port}/api/chat-history/sessions/s1/export${q}`);
    assert.equal(r.status, 400, q);
    const body = await r.json();
    assert.match(body.error, /window required/);
  }
  srv.close();
});

test("2.1 foreign session → 403, unknown id → 404", async () => {
  const srv = await boot({ s1: { owner: "someone@else", title: "T", messages: MESSAGES } });
  const port = srv.address().port;
  const forbidden = await fetch(`http://127.0.0.1:${port}/api/chat-history/sessions/s1/export?window=all`);
  assert.equal(forbidden.status, 403);
  const unknown = await fetch(`http://127.0.0.1:${port}/api/chat-history/sessions/ghost/export?window=all`);
  assert.equal(unknown.status, 404);
  srv.close();
});
