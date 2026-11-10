// Integration tests — zhiyu duty circuit (add-zhiyu-room, task group 6) and
// the agent lane's visitor-scope wire (6.4).
// Run: node --test scripts/test-zhiyu-duty.mjs
//
//   6.1  prompt partition: another member's private window never enters a
//        facade's context; its own principal's private window does. Nothing
//        else does — the private-memory lane does not exist here.
//   6.2  takeover/handback routes flip presences and stream events; handback
//        without a facade is an honest 409.
//   6.3  呼叫: needs_you streams, notify hook fires, an on-duty facade speaks
//        the "已呼叫本人" line via a directive turn.
//   6.4  the live lane stamps metadata.visitor_scope = sha256(room×asker)32
//        on facade turns.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { createZhiyuAgentLane } from "../gateway/zhiyu/agent-lane.js";

async function boot({ calls, notifyCalls = [] } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-duty-"));
  const callAgent = async (member, { text, contextId, scopeSeed }) => {
    calls.push({ ref: member.ref, text, contextId, scopeSeed });
    return { text: "已呼叫我的主人，请等他/她本人回来。" };
  };
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent,
    notify: (type, payload) => notifyCalls.push({ type, payload }),
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
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b) };
  };
  return { srv, base, cli, zhiyu, calls, notifyCalls, close: () => srv.close() };
}

test("6.1 prompt partition: own private window in, other members' out", async () => {
  const { zhiyu, close } = await boot({ calls: [] });
  const { store, router } = zhiyu;
  const room = store.roomCreate({ title: "分区", ownerEmail: "a@x" });
  const uh = store.memberAdd({ roomId: room.id, kind: "user", ref: "a@x" });
  const facadeC = store.memberAdd({ roomId: room.id, kind: "facade", ref: "pack:agent:c", onBehalfOf: "c@x", display: "C 的分身" });
  store.memberAdd({ roomId: room.id, kind: "user", ref: "c@x", presence: "away" });
  const userB = store.memberAdd({ roomId: room.id, kind: "user", ref: "b@x" });
  store.messageAppend({ roomId: room.id, kind: "human", senderMemberId: uh.id, content: "共享的话" });
  store.messageAppend({ roomId: room.id, kind: "agent", visibility: `private:${store.memberFor(room.id, "user", "c@x").id}`, content: "C 的私窗内容" });
  store.messageAppend({ roomId: room.id, kind: "agent", visibility: `private:${userB.id}`, content: "B 的私窗内容" });

  const prompt = router.buildPrompt({ room, agentMember: facadeC, sender: { ref: "a@x", display: "A" }, message: { content: "问一句" }, mode: "direct" });
  assert.ok(prompt.includes("共享的话"), "shared transcript is in context");
  assert.ok(prompt.includes("C 的私窗内容"), "the facade's own private window is in context");
  assert.ok(!prompt.includes("B 的私窗内容"), "another member's private window never enters context");
  close();
});

test("6.2 takeover/handback flip presences and stream events", async () => {
  const { cli, zhiyu, close } = await boot({ calls: [] });
  const a = cli("a@x");
  const c = cli("c@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  await c.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:c", onBehalfOf: "c@x" });
  // Explicit take-over without speaking.
  const tk = await c.post(`/api/zhiyu/rooms/${roomId}/takeover`);
  assert.equal(tk.body.flipped, true);
  let members = tk.body.members;
  assert.equal(members.find((m) => m.kind === "user" && m.ref === "c@x").presence, "active");
  assert.equal(members.find((m) => m.kind === "facade").presence, "listening");
  // Hand back → facade resumes duty, user away.
  const hb = await c.post(`/api/zhiyu/rooms/${roomId}/handback`);
  assert.equal(hb.status, 200);
  members = hb.body.members;
  assert.equal(members.find((m) => m.kind === "user" && m.ref === "c@x").presence, "away");
  assert.equal(members.find((m) => m.kind === "facade").presence, "on_duty");
  const evts = zhiyu.store.messagesAfter(roomId, 0, {}).map((m) => m.meta?.event).filter(Boolean);
  assert.ok(evts.includes("take_over") && evts.includes("hand_back"));
  // Hand back with no facade in room → 409.
  const nofac = await a.post(`/api/zhiyu/rooms/${roomId}/handback`);
  assert.equal(nofac.status, 409);
  close();
});

test("6.3 呼叫: needs_you streams, notify fires, on-duty facade speaks the call line", async () => {
  const calls = [];
  const notifyCalls = [];
  const { cli, zhiyu, close } = await boot({ calls, notifyCalls });
  const a = cli("a@x");
  const c = cli("c@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "呼叫房" })).body.room.id;
  await c.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:c", onBehalfOf: "c@x" });
  const r = await a.post(`/api/zhiyu/rooms/${roomId}/call`, { target: "c@x" });
  assert.equal(r.status, 200);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].type, "call");
  assert.equal(notifyCalls[0].payload.to, "c@x");
  // Directive turn settled as the facade's own in-room line.
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(calls.length, 1, "directive turn dispatched to the facade");
  assert.match(calls[0].text, /系统指令|指令/);
  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.ok(rows.some((m) => m.meta?.event === "needs_you" && m.meta.to === "c@x"));
  assert.ok(rows.some((m) => m.kind === "agent" && m.content.includes("已呼叫")));
  // A call at a ghost member is 404.
  assert.equal((await a.post(`/api/zhiyu/rooms/${roomId}/call`, { target: "ghost@x" })).status, 404);
  close();
});

test("6.4 live lane stamps visitor_scope = sha256(room×asker)32 on facade turns", async () => {
  const lane = createZhiyuAgentLane({
    bookings: { rows: async () => [{ packId: "p", agentId: "a", deployedBy: "c@x", agentPath: "/pa" }] },
    registryUrl: () => "http://lane.local",
    registryToken: () => "gw",
    backendToken: () => "be",
  });
  const seen = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seen.body = JSON.parse(init.body);
    seen.headers = init.headers;
    const sse = `event: message\ndata: ${JSON.stringify({ parts: [{ kind: "text", text: "收到" }] })}\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const out = await lane.callAgent(
      { ref: "p:a", kind: "facade", onBehalfOf: "c@x" },
      { text: "hi", contextId: "room:r1:p:a", scopeSeed: "room:r1:a@x" },
    );
    assert.equal(out.text, "收到");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const scope = seen.body?.params?.message?.metadata?.visitor_scope;
  assert.equal(scope, createHash("sha256").update("room:r1:a@x").digest("hex").slice(0, 32));
  assert.equal(seen.headers["X-Authorization"], "Bearer gw");
  assert.equal(seen.headers.Authorization, "Bearer be");
  assert.equal(seen.headers["X-Delegation-Depth"], undefined, "room turns carry no delegation depth");
});
