// Integration tests — zhiyu notifications lane (add-zhiyu-room, group 8).
// Run: node --test scripts/test-zhiyu-notify.mjs
//
//   8.1  invite lands an unread row for the invited principal; 呼叫同样；
//        read-once mechanics keep the unread counter honest.
//   8.2  room end (owner-ended and idle alike) delivers a minutes digest to
//        every member and to each facade's principal.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-notify-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    callAgent: async () => ({ text: "占位回答" }),
    env: {},
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
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b) };
  };
  return { srv, base, cli, zhiyu, close: () => srv.close() };
}

test("8.1 invite + call land unread rows; accept clears the invite notice; mark-read honest", async () => {
  const { cli, close } = await boot();
  const a = cli("a@x");
  const b = cli("b@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "铃" })).body.room.id;
  await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  let inbox = (await b.get("/api/zhiyu/notifications")).body;
  assert.equal(inbox.unread, 1);
  assert.equal(inbox.notifications[0].type, "invite");
  assert.equal(inbox.notifications[0].payload.roomTitle, "铃");

  // Accepting the invite clears its own notice (polish-web-surfaces: the badge
  // must not stay lit after the decision).
  const inviteId = (await b.get("/api/zhiyu/invites")).body.invites[0].id;
  await b.post(`/api/zhiyu/invites/${inviteId}/accept`);
  inbox = (await b.get("/api/zhiyu/notifications")).body;
  assert.equal(inbox.unread, 0, "accepting the invite must clear its notice");

  await a.post(`/api/zhiyu/rooms/${roomId}/call`, { target: "b@x" });
  inbox = (await b.get("/api/zhiyu/notifications")).body;
  assert.equal(inbox.unread, 1);
  assert.ok(inbox.notifications.some((n) => n.type === "call"));

  // Mark-read is scoped to the owner and idempotent.
  const nid = inbox.notifications.find((n) => n.type === "call").id;
  await a.post(`/api/zhiyu/notifications/${nid}/read`); // foreign: no-op at b's counter
  assert.equal((await b.get("/api/zhiyu/notifications")).body.unread, 1);
  const after = await b.post(`/api/zhiyu/notifications/${nid}/read`);
  assert.equal(after.body.unread, 0);
  // unreadOnly view filters settled rows.
  const unreadOnly = (await b.get("/api/zhiyu/notifications?unread=1")).body;
  assert.equal(unreadOnly.notifications.length, 0);
  close();
});

test("8.3 read-all clears the lane in one call and stays per-user", async (t) => {
  const { cli, close } = await boot();
  t.after(close);
  const a = cli("a@x");
  const b = cli("b@x");
  const r1 = (await a.post("/api/zhiyu/rooms", { title: "甲" })).body.room.id;
  const r2 = (await a.post("/api/zhiyu/rooms", { title: "乙" })).body.room.id;
  await a.post(`/api/zhiyu/rooms/${r1}/invites`, { kind: "user", ref: "b@x" });
  await a.post(`/api/zhiyu/rooms/${r2}/invites`, { kind: "user", ref: "b@x" });
  assert.equal((await b.get("/api/zhiyu/notifications")).body.unread, 2);

  const aBefore = (await a.get("/api/zhiyu/notifications")).body.unread;
  const out = await b.post("/api/zhiyu/notifications/read-all");
  assert.equal(out.body.unread, 0, "read-all returns the fresh count");
  assert.equal((await b.get("/api/zhiyu/notifications")).body.unread, 0);
  assert.equal((await a.get("/api/zhiyu/notifications")).body.unread, aBefore, "another user's lane is untouched");
  assert.equal((await b.post("/api/zhiyu/notifications/read-all")).body.unread, 0, "read-all is idempotent");
});

test("8.2 room end delivers a minutes digest to members and facade principals", async () => {
  const { cli, close } = await boot();
  const a = cli("a@x");
  const b = cli("b@x");
  const c = cli("c@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "纪要" })).body.room.id;
  await c.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "p:x:c", onBehalfOf: "c@x" });
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await b.post(`/api/zhiyu/invites/${inv.body.invite.id}/accept`);
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "今天的结论是照方案 A 走" });
  await a.post(`/api/zhiyu/rooms/${roomId}/end`);

  for (const [who, email] of [["owner", "a@x"], ["member", "b@x"], ["facade principal", "c@x"]]) {
    const inbox = (await cli(email).get("/api/zhiyu/notifications")).body;
    const minutes = inbox.notifications.find((n) => n.type === "minutes");
    assert.ok(minutes, `${who} should receive minutes`);
    assert.equal(minutes.payload.roomTitle, "纪要");
    assert.ok(minutes.payload.messageCount >= 1);
    assert.ok(minutes.payload.tail.some((t) => t.content.includes("方案 A")));
  }
  close();
});
