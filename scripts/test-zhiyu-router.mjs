// Integration tests — zhiyu round router (add-zhiyu-room, task group 5).
// Run: node --test scripts/test-zhiyu-router.mjs
//
//   5.1  @mention wakes only the addressed seat (others zero-turn zero-cost).
//   5.2  broadcast solicit: pass settles as an event, not a chat row.
//   5.3  fuse: non-pass answers past the room cap are refused with
//        reply_cap_hit; earlier answers stand.
//   5.4  busy: a re-pointed agent mid-turn gets an agent_busy mark.
//   5.5  contextId is room:<roomId>:<ref> composite.
//   5.6  agent replies never re-trigger the router (hard circuit breaker),
//        even when the reply @-names another seat.
//   5.7  lane failures settle honest: insolvency phrased separately.
//   5.8  a `listening` facade is not broadcast-eligible but answers a direct
//        mention.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

async function boot({ agentScript = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-router-"));
  const calls = []; // { ref, text, contextId }
  const callAgent = async (member, { text, contextId, onDelta }) => {
    calls.push({ ref: member.ref, text, contextId });
    const script = agentScript[member.ref] ?? { answer: `（${member.display}的回答）` };
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    if (script.delta) onDelta?.(script.delta);
    if (script.throw) throw new Error(script.throw);
    return { text: script.answer };
  };
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent,
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => {
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b) };
  };
  const close = () => srv.close();
  return { srv, base, cli, zhiyu, calls, close };
}

async function waitFor(fn, { tries = 60, ms = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
}

// Seed a room with the given agent seats and return ids.
async function seedRoom(cli, zhiyu, ownerEmail, seats) {
  const created = await cli(ownerEmail).post("/api/zhiyu/rooms", { title: "路由" });
  const roomId = created.body.room.id;
  for (const s of seats) {
    zhiyu.store.memberAdd({ roomId, kind: s.kind ?? "agent", ref: s.ref, display: s.display ?? s.ref, onBehalfOf: s.onBehalfOf ?? null, ...(s.presence ? { presence: s.presence } : {}) });
  }
  return roomId;
}

test("5.1 @mention wakes only the addressed seat", async () => {
  const { cli, zhiyu, calls, close } = await boot();
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [{ ref: "deep" , display: "DeepResearch" }, { ref: "pundit", display: "Pundit" }]);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@DeepResearch 这个数据怎么看" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.kind === "agent"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, "deep");
  close();
});

test("5.2 broadcast: pass settles as event, never a chat row", async () => {
  const { cli, zhiyu, calls, close } = await boot({ agentScript: { pundit: { answer: "「过」" } } });
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [{ ref: "deep", display: "DeepResearch" }, { ref: "pundit", display: "Pundit" }]);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "大家都看看这个" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.meta?.event === "pass"));
  assert.equal(calls.length, 2); // both solicited once
  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.ok(!rows.some((m) => m.kind === "agent" && m.content.startsWith("「过」")), "pass must not land as a chat row");
  assert.ok(rows.some((m) => m.kind === "agent"), "the answering seat settled a chat row");
  close();
});

test("5.3 fuse: cap refuses extra answers with reply_cap_hit, earlier answers stand", async () => {
  const { cli, zhiyu, close } = await boot();
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [{ ref: "one", display: "One" }, { ref: "two", display: "Two" }]);
  await a.patch(`/api/zhiyu/rooms/${roomId}`, { replyCap: 1 });
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "都说说" });
  const rows = await waitFor(() => {
    const r = zhiyu.store.messagesAfter(roomId, 0, {});
    return r.some((m) => m.meta?.event === "reply_cap_hit") ? r : null;
  });
  assert.equal(rows.filter((m) => m.kind === "agent").length, 1, "exactly the capped count of answers");
  close();
});

test("5.4 busy: re-pointing a mid-turn seat marks agent_busy", async () => {
  const { cli, zhiyu, close } = await boot({ agentScript: { slow: { answer: "慢答", delayMs: 300 } } });
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [{ ref: "slow", display: "Slow" }]);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@Slow 第一个问题" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).length >= 2); // let the turn start
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@Slow 第二个问题" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.meta?.event === "agent_busy"));
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.kind === "agent"));
  close();
});

test("5.5 contextId is the room×agent composite", async () => {
  const { cli, zhiyu, calls, close } = await boot();
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [{ ref: "deep", display: "DeepResearch" }]);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@DeepResearch 在吗" });
  await waitFor(() => calls.length >= 1);
  assert.equal(calls[0].contextId, `room:${roomId}:deep`);
  close();
});

test("5.6 agent replies never re-trigger the router, even @-naming a seat", async () => {
  const { cli, zhiyu, calls, close } = await boot({ agentScript: { deep: { answer: "我认为该让 @Pundit 接话" } } });
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [{ ref: "deep", display: "DeepResearch" }, { ref: "pundit", display: "Pundit" }]);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@DeepResearch 怎么看" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.kind === "agent"));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.length, 1, "pundit was never woken by the agent's own text");
  close();
});

test("5.7 lane failures settle honest: insolvency phrased separately", async () => {
  const { cli, zhiyu, close } = await boot({
    agentScript: { broke: { throw: "A2A HTTP 402: quota exceeded (balance)" }, flaky: { throw: "socket hangup" } },
  });
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [{ ref: "broke", display: "Broke" }, { ref: "flaky", display: "Flaky" }]);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "都说话" });
  const rows = await waitFor(() => {
    const r = zhiyu.store.messagesAfter(roomId, 0, {});
    const evts = r.filter((m) => m.meta?.event?.startsWith("agent_"));
    return evts.length >= 2 ? r : null;
  });
  assert.ok(rows.some((m) => m.meta?.event === "agent_declined_insolvent" && m.meta.memberId));
  assert.ok(rows.some((m) => m.meta?.event === "agent_failed"));
  close();
});

test("5.8 a listening facade skips broadcast but answers a direct mention", async () => {
  const { cli, zhiyu, calls, close } = await boot();
  const a = cli("a@x");
  const roomId = await seedRoom(cli, zhiyu, "a@x", [
    { ref: "facade:c", kind: "facade", display: "C 的分身", onBehalfOf: "c@x", presence: "listening" },
    { ref: "deep", display: "DeepResearch" },
  ]);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "广播一句" });
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ref, "deep", "listening facade was not solicited");
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@C 的分身 你也说" });
  await waitFor(() => calls.length >= 2);
  assert.equal(calls[1].ref, "facade:c", "a direct mention still wakes it");
  close();
});
