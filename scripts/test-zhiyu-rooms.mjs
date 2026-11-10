// Integration tests — zhiyu room routes (add-zhiyu-room, task groups 3 & 4).
// Run: node --test scripts/test-zhiyu-rooms.mjs
//
//   3.x  lifecycle & authz: create/get/list, non-member 404, hatch seeding,
//        invite handshake (user accept, facade policies auto/ask/decline),
//        leave→transfer-or-end, ended room read-only.
//   4.x  messages: send+read consistency, SSE replay by seq, private window.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

async function boot({ cellExport = null, hooks = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-rooms-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    cellExport,
    ssePollMs: 60,
    startTimers: false,
    ...hooks,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { srv, zhiyu, base: `http://127.0.0.1:${srv.address().port}` };
}

// Minimal client keyed by the test identity header.
function cli(base, email) {
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await r.json(); } catch { /* SSE etc. */ }
    return { status: r.status, body: json, raw: r };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, body) => call("POST", p, body ?? {}),
    patch: (p, body) => call("PATCH", p, body),
    put: (p, body) => call("PUT", p, body),
  };
}

test("3.1 create/get/list; non-member gets 404", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const b = cli(base, "b@x");
  const created = await a.post("/api/zhiyu/rooms", { title: "复盘" });
  assert.equal(created.status, 200);
  const roomId = created.body.room.id;
  assert.equal(created.body.effectiveReplyCap, 3);

  // Owner sees it in the list; B does not.
  assert.equal((await a.get("/api/zhiyu/rooms")).body.rooms.length, 1);
  assert.equal((await b.get("/api/zhiyu/rooms")).body.rooms.length, 0);
  // B cannot read it.
  assert.equal((await b.get(`/api/zhiyu/rooms/${roomId}`)).status, 404);
  srv.close();
});

test("3.2 hatch seeds provenance history from the cell export", async () => {
  const { srv, base } = await boot({
    cellExport: async (_user, sessionId, _window) => ({
      sessionId,
      title: "源会话",
      window: { kind: "last", n: 2 },
      messages: [
        { role: "user", content: "问" },
        { role: "assistant", content: "答" },
      ],
    }),
  });
  const a = cli(base, "a@x");
  const created = await a.post("/api/zhiyu/rooms", { title: "", hatch: { sessionId: "s1", window: "last:2" } });
  assert.equal(created.status, 200);
  const roomId = created.body.room.id;
  assert.equal(created.body.room.sourceSession, "s1");
  const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.equal(msgs[0].content, "问");
  assert.equal(msgs[0].provenance, "session:s1");
  assert.equal(msgs[1].fromAgent, true);
  assert.equal(msgs[2].meta.event, "room_hatched");
  srv.close();
});

test("3.3 invite handshake: user accept lands a seat; stranger cannot accept", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const b = cli(base, "b@x");
  const c = cli(base, "c@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  assert.equal(inv.status, 200);
  const inviteId = inv.body.invite.id;
  // B sees it as actionable; C does not.
  assert.equal((await b.get("/api/zhiyu/invites")).body.invites.length, 1);
  assert.equal((await c.get("/api/zhiyu/invites")).body.invites.length, 0);
  assert.equal((await c.post(`/api/zhiyu/invites/${inviteId}/accept`)).status, 404);
  // B accepts → seated, rooms list shows it, join event streamed.
  assert.equal((await b.post(`/api/zhiyu/invites/${inviteId}/accept`)).status, 200);
  assert.equal((await b.get(`/api/zhiyu/rooms/${roomId}`)).status, 200);
  const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.ok(msgs.some((m) => m.meta?.event === "member_joined"));
  srv.close();
});

test("3.4 facade invite policies: auto_accept seats immediately; ask waits; decline auto-declines", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const c = cli(base, "c@x");
  const d = cli(base, "d@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;

  // C's policy: auto_accept
  await c.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  const auto = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:c", onBehalfOf: "c@x", display: "C 的分身" });
  assert.equal(auto.body.policy, "auto_accept");
  assert.equal(auto.body.invite.state, "accepted");
  const members = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.members;
  assert.ok(members.some((m) => m.kind === "facade" && m.presence === "on_duty"));
  // The principal's own user seat rides in (away) — they can already read the room.
  assert.ok(members.some((m) => m.kind === "user" && m.ref === "c@x" && m.presence === "away"));
  assert.equal((await c.get(`/api/zhiyu/rooms/${roomId}`)).status, 200);

  // D leaves policy at the shipped default (ask) → pending, not seated.
  const ask = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:d", onBehalfOf: "d@x" });
  assert.equal(ask.body.invite.state, "pending");
  assert.equal((await d.get("/api/zhiyu/invites")).body.invites.length, 1);

  // E's policy: decline → resolved declined at once, never seated.
  const e = cli(base, "e@x");
  await e.put("/api/zhiyu/policies/facade", { facadeInvite: "decline" });
  const dec = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:e", onBehalfOf: "e@x" });
  assert.equal(dec.body.invite.state, "declined");
  srv.close();
});

test("3.5 leave: owner leave transfers to eldest user; messages blocked after owner-left end", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const b = cli(base, "b@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await b.post(`/api/zhiyu/invites/${inv.body.invite.id}/accept`);
  // A leaves → B inherits ownership (owner_transferred event).
  const left = await a.post(`/api/zhiyu/rooms/${roomId}/leave`);
  assert.equal(left.body.room.ownerEmail, "b@x");
  assert.equal(left.body.room.status, "active");
  // A is now a stranger: 404 on read.
  assert.equal((await a.get(`/api/zhiyu/rooms/${roomId}`)).status, 404);
  // B ends it; posting afterwards is 409.
  await b.post(`/api/zhiyu/rooms/${roomId}/end`);
  const post = await b.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "尾巴" });
  assert.equal(post.status, 409);
  srv.close();
});

test("3.6 replyCap two-level config: patch honors bounds, clear falls back to default", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const b = cli(base, "b@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  assert.equal((await a.patch(`/api/zhiyu/rooms/${roomId}`, { replyCap: 5 })).body.room.effectiveReplyCap, 5);
  // Out-of-bounds refused, effective value untouched.
  const bad = await a.patch(`/api/zhiyu/rooms/${roomId}`, { replyCap: 99 });
  assert.equal(bad.status, 400);
  assert.equal((await a.get(`/api/zhiyu/rooms/${roomId}`)).body.room.effectiveReplyCap, 5);
  // Only the owner may patch.
  assert.equal((await b.patch(`/api/zhiyu/rooms/${roomId}`, { replyCap: 1 })).status, 404);
  // Clear override → deployment default 3.
  assert.equal((await a.patch(`/api/zhiyu/rooms/${roomId}`, { replyCap: null })).body.room.effectiveReplyCap, 3);
  const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.ok(msgs.filter((m) => m.meta?.event === "reply_cap_changed").length >= 2);
  srv.close();
});

test("3.9 ref case rules: emails lowercase, deployment refs keep case", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "  MixEd@Corp.com " });
  assert.equal(inv.body.invite.ref, "mixed@corp.com");
  const dep = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "agent", ref: "Ut_bJMuW5KxAD83KImPmlg:reception", onBehalfOf: "c@x" });
  assert.equal(dep.body.invite.ref, "Ut_bJMuW5KxAD83KImPmlg:reception", "mixed-case deployment ref preserved verbatim");
  srv.close();
});

test("3.8 owner removes a member: removed seat loses read access, stranger cannot remove", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const b = cli(base, "b@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await b.post(`/api/zhiyu/invites/${inv.body.invite.id}/accept`);
  // B cannot remove anyone (not the owner).
  const bMemberId = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.members.find((m) => m.ref === "b@x").id;
  assert.equal((await b.post(`/api/zhiyu/rooms/${roomId}/remove`, { memberId: bMemberId })).status, 403);
  // Owner removes B → B's read now 404s, removal event streamed.
  assert.equal((await a.post(`/api/zhiyu/rooms/${roomId}/remove`, { memberId: bMemberId })).status, 200);
  assert.equal((await b.get(`/api/zhiyu/rooms/${roomId}`)).status, 404);
  const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.ok(msgs.some((m) => m.meta?.event === "member_removed"));
  srv.close();
});

test("3.7 idle auto-close: sweep ends stale rooms and streams room_ended(idle)", async () => {
  const { srv, base, zhiyu } = await boot();
  const a = cli(base, "a@x");
  const fresh = (await a.post("/api/zhiyu/rooms", { title: "活" })).body.room;
  const stale = (await a.post("/api/zhiyu/rooms", { title: "旧", idleMinutes: 1 })).body.room;
  zhiyu.store.roomTouch(stale.id, Date.now() - 120_000); // 2min inactive > 1min budget
  zhiyu.sweep();
  assert.equal(zhiyu.store.roomGet(stale.id).status, "ended");
  assert.equal(zhiyu.store.roomGet(fresh.id).status, "active");
  const msgs = zhiyu.store.messagesAfter(stale.id, 0, {});
  assert.ok(msgs.some((m) => m.meta?.event === "room_ended" && m.meta.reason === "idle"));
  srv.close();
});

test("4.1 message send+read round trip with sender attribution", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "第一句" });
  const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  const mine = msgs.find((m) => m.content === "第一句");
  assert.equal(mine.kind, "human");
  const members = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.members;
  assert.equal(mine.senderMemberId, members.find((m) => m.ref === "a@x").id);
  assert.equal(mine.seq, 2); // room_created event is seq 1
  srv.close();
});

test("4.2 SSE replays from `after` and streams new rows", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "早先" });

  // Open the stream with after=1 → we should see seq 2 replayed immediately,
  // then a live row we post afterwards.
  const r = await fetch(`${base}/api/zhiyu/rooms/${roomId}/events?after=1`, { headers: { "x-user": "a@x" } });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readUntil = async (needle, tries = 40) => {
    for (let i = 0; i < tries && !buf.includes(needle); i++) {
      const { value } = await reader.read();
      buf += decoder.decode(value ?? new Uint8Array(), { stream: true });
    }
    assert.ok(buf.includes(needle), `stream should contain ${needle}; got: ${buf.slice(0, 400)}`);
  };
  await readUntil("早先");
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "新到" });
  await readUntil("新到");
  reader.cancel().catch(() => {});
  srv.close();
});

test("4.3 private window: visible to its member only", async () => {
  const { srv, base, zhiyu } = await boot();
  const a = cli(base, "a@x");
  const b = cli(base, "b@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await b.post(`/api/zhiyu/invites/${inv.body.invite.id}/accept`);
  const aMember = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.myMemberId;
  // Seed a private row directly through the store (agent rows arrive this way
  // until the round router exists in group 5).
  zhiyu.store.messageAppend({ roomId, kind: "agent", visibility: `private:${aMember}`, content: "悄悄话" });
  const forA = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  const forB = (await b.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.ok(forA.some((m) => m.content === "悄悄话"));
  assert.ok(!forB.some((m) => m.content === "悄悄话"));
  srv.close();
});

test("4.4 speaking is implicit take-over: facade steps back to listening", async () => {
  const { srv, base } = await boot();
  const a = cli(base, "a@x");
  const c = cli(base, "c@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  await c.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:c", onBehalfOf: "c@x" });
  // C rides along via its facade (reads OK); speaking is take-over.
  assert.equal((await c.get(`/api/zhiyu/rooms/${roomId}/messages`)).status, 200);
  const post = await c.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "我来——这话我本人说" });
  assert.equal(post.status, 200);
  const members = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.members;
  assert.equal(members.find((m) => m.kind === "user" && m.ref === "c@x").presence, "active");
  assert.equal(members.find((m) => m.kind === "facade").presence, "listening");
  const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.ok(msgs.some((m) => m.meta?.event === "take_over" && m.meta.by === "c@x"));
  // Facade seats never post as humans: no user-seat, no say — a room where
  // a facade's principal never joined is unreachable through the user gate.
  srv.close();
});

// ── add-zhiyu-private-window-send: the send face ───────────────────────────

test("4.5 private send: exchange lands private档; shared reads exclude; -private settle + budget", async () => {
  const settles = [];
  const { srv, base, zhiyu } = await boot({
    hooks: {
      callAgent: async () => ({ text: "私窗回答：口径是 42" }),
      settleTurn: async (_member, usage) => settles.push(usage),
    },
  });
  const a = cli(base, "a@x");
  const b = cli(base, "b@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "私窗间" })).body.room.id;
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await b.post(`/api/zhiyu/invites/${inv.body.invite.id}/accept`);
  // A's own duty facade (policy owner is the onBehalfOf principal).
  await a.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:a", onBehalfOf: "a@x" });
  const aMember = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.myMemberId;

  const sent = await a.post(`/api/zhiyu/rooms/${roomId}/private`, { content: "私窗吩咐一" });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.kind, "human");
  assert.equal(sent.body.message.visibility, `private:${aMember}`);

  // The facade answers on the same档 (fire-and-forget dispatch — poll).
  let answer = null;
  for (let i = 0; i < 60 && !answer; i++) {
    const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
    answer = msgs.find((m) => m.kind === "agent" && m.content === "私窗回答：口径是 42") ?? null;
    if (!answer) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(answer, "facade answer lands in the member's private window");
  assert.equal(answer.visibility, `private:${aMember}`, "answer rides the same private档 as the ask");
  assert.equal(answer.replyToSeq, sent.body.message.seq);
  assert.equal(answer.meta?.mode, "private");

  // Billing: settles on the facade seat with the -private attribution suffix;
  // the room's daily budget counted the turn (room-overhead口径).
  assert.equal(settles.length, 1);
  assert.ok(settles[0].usageId.endsWith("-private"), `usage id carries private scope: ${settles[0].usageId}`);
  assert.ok(settles[0].minutes >= 1);
  assert.equal(zhiyu.store.roomDayTurnsPeek(roomId), 1);

  // Shared read surfaces exclude BOTH rows: the other member sees neither.
  const forB = (await b.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.ok(!forB.some((m) => m.content === "私窗吩咐一" || m.content === "私窗回答：口径是 42"));
  // The member's own read shows the full exchange.
  const forA = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
  assert.ok(forA.some((m) => m.content === "私窗吩咐一"));
  assert.ok(forA.some((m) => m.content === "私窗回答：口径是 42"));
  srv.close();
});

test("4.6 private send: no active user seat → 403; nothing persists", async () => {
  const { srv, base, zhiyu } = await boot();
  const a = cli(base, "a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  const aMember = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.myMemberId;
  // A guest in the wild rides the widget/IM lanes and never holds a user
  // seat; inside this kernel the gate's exact shape is "member without an
  // active user seat" — simulate it by demoting A's own seat off active.
  zhiyu.store.memberSetState(aMember, "pending");
  const before = zhiyu.store.messagesAfter(roomId, 0, { viewerMemberId: null }).length;
  const refused = await a.post(`/api/zhiyu/rooms/${roomId}/private`, { content: "不该出现" });
  assert.equal(refused.status, 403);
  const after = zhiyu.store.messagesAfter(roomId, 0, { viewerMemberId: null }).length;
  assert.equal(after, before, "refusal persists nothing");
  srv.close();
});

test("4.7 private send: facade absent → readable 409; nothing persists", async () => {
  const { srv, base, zhiyu } = await boot();
  const a = cli(base, "a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).body.room.id;
  const count = () => zhiyu.store.messagesAfter(roomId, 0, { viewerMemberId: null }).length;
  const before = count();
  // No facade invited at all.
  const noFacade = await a.post(`/api/zhiyu/rooms/${roomId}/private`, { content: "有人吗" });
  assert.equal(noFacade.status, 409);
  assert.ok(String(noFacade.body.error).includes("值守分身未在场"));
  assert.equal(count(), before, "absent-facade refusal persists nothing");
  srv.close();
});

test("4.8 private send: room over daily budget → honest refusal on the private档", async () => {
  const { srv, base, zhiyu } = await boot({
    hooks: { callAgent: async () => ({ text: "回答" }) },
  });
  const a = cli(base, "a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "", dailyBudgetTurns: 1 })).body.room.id;
  await a.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "pack:agent:a", onBehalfOf: "a@x" });
  const aMember = (await a.get(`/api/zhiyu/rooms/${roomId}`)).body.myMemberId;
  // A plain agent seat burns the budget: A's OWN facade can't (speaking is
  // take-over — the shared round makes the facade step back to listening and
  // the broadcast skips it), which is exactly why the private lane exists.
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "pk:agent", display: "值岗智能体" });
  // Burn the day's single turn through a shared round (poll, not a fixed
  // sleep — the round is fire-and-forget).
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "占一天预算" });
  let burned = 0;
  for (let i = 0; i < 60 && !burned; i++) {
    burned = zhiyu.store.roomDayTurnsPeek(roomId);
    if (!burned) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(burned, 1);
  // The private lane is gated by the same ceiling: refusal event lands on
  // the member's private档, the shared stream stays clean.
  const over = await a.post(`/api/zhiyu/rooms/${roomId}/private`, { content: "私窗也要过闸" });
  assert.equal(over.status, 200, "the ask itself is accepted; the refusal is an event row");
  for (let i = 0; i < 40; i++) {
    const msgs = (await a.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages;
    if (msgs.some((m) => m.meta?.event === "budget_exhausted")) {
      assert.equal(msgs.find((m) => m.meta?.event === "budget_exhausted").visibility, `private:${aMember}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(zhiyu.store.roomDayTurnsPeek(roomId), 1, "no second turn consumed");
  srv.close();
});
