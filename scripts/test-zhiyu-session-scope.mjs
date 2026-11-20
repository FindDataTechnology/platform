// Session scope (zhiyu-room-session-scope 1.2 / 2.1).
// Run: node --test scripts/test-zhiyu-session-scope.mjs
//
// The bug: the room opens per CHAT while seats are keyed per PERSON, but the
// agent context had no speaker dimension at all — so a customer's words landed
// in the same memory as the next customer's. Shared rooms must keep working
// byte-for-byte; isolated rooms must not leak one speaker's words into another's.

import test from "node:test";
import assert from "node:assert/strict";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function boot() {
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-scope-"));
  const calls = []; // { ref, contextId, text }
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    env: {},
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "auth" }),
    callAgent: async (member, { text, contextId }) => {
      calls.push({ ref: member.ref, contextId, text });
      return { text: `${member.display}答` };
    },
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (method, p, body, user = "a@x") => {
    const r = await fetch(base + p, {
      method,
      headers: { "x-user": user, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  };
  return { zhiyu, calls, j, close: () => srv.close() };
}

async function seed(j, zhiyu, { scope = null, seats = ["advisor"] } = {}) {
  const room = await j("POST", "/api/zhiyu/rooms", { title: "t" });
  const roomId = room.data.room?.id ?? room.data.id;
  for (const ref of seats) zhiyu.store.memberAdd({ roomId, kind: "agent", ref, display: ref });
  if (scope) await j("PATCH", `/api/zhiyu/rooms/${roomId}`, { sessionScope: scope });
  return roomId;
}

const ctxFor = (calls, ref) => calls.filter((c) => c.ref === ref).map((c) => c.contextId);

test("a shared room keeps the EXACT pre-change contextId", async () => {
  // The string is hashed into a sessionId, so any change here wipes the agent
  // memory of every existing room. This assertion is the guard against a
  // "harmless tidy-up" that would look fine and lose everyone's context.
  const { calls, j, zhiyu, close } = await boot();
  const roomId = await seed(j, zhiyu);
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "@advisor 你好" });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ctxFor(calls, "advisor"), [`room:${roomId}:advisor`]);
  close();
});

test("a per-sender room gives different speakers different contexts", async () => {
  const { calls, j, zhiyu, close } = await boot();
  const roomId = await seed(j, zhiyu, { scope: "per-sender" });
  // Two different signed-in members speak. b@x must ACCEPT the invite first —
  // an invite is an offer, not a seat (the same trap as the commander tests).
  const inv = await j("POST", `/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x", historyGrant: "join_from" });
  const inviteId = inv.data?.id ?? inv.data?.invite?.id ?? null;
  if (inviteId) await j("POST", `/api/zhiyu/invites/${inviteId}/accept`, undefined, "b@x");
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "@advisor 我的预算是一百万" }, "a@x");
  await new Promise((r) => setTimeout(r, 200));
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "@advisor 你知道我的预算吗" }, "b@x");
  await new Promise((r) => setTimeout(r, 200));

  const ids = ctxFor(calls, "advisor");
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "two speakers must not share one memory");
  assert.ok(ids.every((id) => id.startsWith(`room:${roomId}:advisor:`)), "and both keep the room+seat prefix");
  close();
});

test("the same speaker keeps one context across turns", async () => {
  const { calls, j, zhiyu, close } = await boot();
  const roomId = await seed(j, zhiyu, { scope: "per-sender" });
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "第一句" });
  await new Promise((r) => setTimeout(r, 200));
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "第二句" });
  await new Promise((r) => setTimeout(r, 200));
  const ids = ctxFor(calls, "advisor");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], "one speaker, one memory — that is the point");
  close();
});

test("an unrecognised scope degrades to shared, never to isolation", async () => {
  // A typo must not silently partition people; the safe direction is the
  // behaviour everyone already has.
  const { j, zhiyu, close } = await boot();
  const room = await j("POST", "/api/zhiyu/rooms", { title: "t" });
  const roomId = room.data.room?.id ?? room.data.id;
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "advisor", display: "advisor" });
  const patched = await j("PATCH", `/api/zhiyu/rooms/${roomId}`, { sessionScope: "per-sender-typo" });
  assert.equal(patched.status, 400, "an invalid value is refused at the write, not stored");
  close();
});

// ── The window (3.2 / 3.3) ───────────────────────────────────────────────────
test("a truncated window says so, and an untruncated one does not", async () => {
  // The sharpest failure users noticed: the agent treats a fragment as the whole
  // history and invents a reason for not knowing earlier turns.
  const { calls, j, zhiyu, close } = await boot();
  const roomId = await seed(j, zhiyu, { seats: ["advisor"] });
  // Small window so a handful of messages is enough to overflow it.
  await j("PATCH", `/api/zhiyu/rooms/${roomId}`, { contextWindow: 4 });

  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "@advisor 第一问" });
  await new Promise((r) => setTimeout(r, 150));
  const firstPrompt = calls[calls.length - 1].text;
  assert.ok(!/更早的对话，不在你的上下文中/.test(firstPrompt), "a short history is not marked");

  for (let i = 0; i < 6; i++) {
    await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: `填充 ${i}` });
    await new Promise((r) => setTimeout(r, 60));
  }
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "@advisor 最后一问" });
  await new Promise((r) => setTimeout(r, 200));
  const laterPrompt = calls[calls.length - 1].text;
  assert.ok(/更早的对话，不在你的上下文中/.test(laterPrompt), "an overflowing history is marked");
  close();
});

test("the speaker's own recent turns survive an overflowing window", async () => {
  // Otherwise the agent cannot remember what the person in front of it JUST
  // said — worse than not knowing old history.
  const { calls, j, zhiyu, close } = await boot();
  const roomId = await seed(j, zhiyu, { seats: ["advisor"] });
  await j("PATCH", `/api/zhiyu/rooms/${roomId}`, { contextWindow: 4 });

  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "@advisor 暗号：紫罗兰" });
  await new Promise((r) => setTimeout(r, 150));
  // Flood with rows from ANOTHER SEATED member so the speaker's line falls out
  // of the plain window. A message from a non-member never lands in the room,
  // so using f0@x here would prove nothing (measured: the window never filled).
  const inv = await j("POST", `/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "other@x", historyGrant: "join_from" });
  const inviteId = inv.data?.id ?? inv.data?.invite?.id ?? null;
  if (inviteId) await j("POST", `/api/zhiyu/invites/${inviteId}/accept`, undefined, "other@x");
  for (let i = 0; i < 8; i++) {
    await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: `闲聊 ${i}` }, "other@x");
    await new Promise((r) => setTimeout(r, 50));
  }
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "@advisor 暗号是什么" });
  await new Promise((r) => setTimeout(r, 200));
  const prompt = calls[calls.length - 1].text;
  assert.ok(prompt.includes("紫罗兰"), "the speaker's own earlier line is still in context");
  close();
});
