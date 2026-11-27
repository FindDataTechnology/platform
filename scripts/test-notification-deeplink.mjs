// Room notifications on a phone: what they carry and where they land
// (openspec: add-zhiyu-mobile-clients, 6.1 / 6.2).
//
// A push notification is the only surface where room content leaves every access
// check we own: it renders on a lock screen, mirrors to a watch, and gets quoted
// in a reply. And a badge is the only UI element that can announce a thing with
// no row to open. Both are pinned here.
//
//   node --test scripts/test-notification-deeplink.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const { notificationDeepLink, notificationTemplateParams, NOTIFICATION_TEMPLATE_KEYS, templateKeys } = await import(
  "../packages/core/src/notification-deeplink.ts"
);

const OPEN = [];
test.after(() => Promise.all(OPEN.map((srv) => new Promise((r) => srv.close(r)))));

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notify-dl-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: path.join(tmp, "data"),
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent: async (member) => ({ text: `（${member.display}的回答）` }),
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  OPEN.push(srv);
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
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}) };
  };
  return { cli, zhiyu, close: () => srv.close() };
}

async function seedRoom(cli) {
  const created = await cli("a@x").post("/api/zhiyu/rooms", { title: "通知房" });
  const roomId = created.body.room.id;
  const invited = await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await cli("b@x").post(`/api/zhiyu/invites/${invited.body.invite.id}/accept`, {});
  return roomId;
}

/** Every string inside a value, for "no room content anywhere" assertions. */
function stringsOf(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

// ── 6.1 the payload carries a position, not a conversation ────────────────

test("6.1 a call notification carries the room, an exact seq, and no body", async () => {
  const { cli, zhiyu, close } = await boot();
  const roomId = await seedRoom(cli);
  // Something said in the room that must never reach a lock screen.
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "季度预算 4800 万，别外传" });

  const called = await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/call`, { target: "b@x" });
  assert.equal(called.status, 200);

  const inbox = await cli("b@x").get("/api/zhiyu/notifications");
  const call = inbox.body.notifications.find((n) => n.type === "call");
  assert.ok(call, "the callee gets a call notification");
  assert.equal(call.roomId, roomId);
  assert.equal(call.payload.roomTitle, "通知房", "the room's NAME travels; the room list already shows it");

  // The position is the needs_you row itself — the one the client scrolls to.
  const rows = zhiyu.store.messagesTail(roomId, 50, { viewerMemberId: null });
  const needsYou = rows.find((m) => m.meta?.event === "needs_you" && m.meta?.to === "b@x");
  assert.ok(needsYou, "the call emitted a needs_you row");
  assert.equal(call.payload.seq, needsYou.seq, "the seq names the row to open");

  // No conversation, in any spelling.
  const all = stringsOf(call.payload).join("\n");
  assert.equal(all.includes("4800"), false, "no message text in the notification");
  assert.deepEqual(Object.keys(call.payload).sort(), ["from", "roomId", "roomTitle", "seq", "to"], "payload is a closed set of fields");
  close();
});

test("6.1 the push template is an allowlist: a new content field cannot leak by being added", () => {
  assert.deepEqual(templateKeys(), [...NOTIFICATION_TEMPLATE_KEYS]);
  const payload = {
    roomTitle: "通知房",
    seq: 42,
    from: "a@x",
    count: 3,
    // Every shape a message body could take, plus the digest tail the minutes
    // notification actually carries today.
    content: "季度预算 4800 万",
    text: "季度预算 4800 万",
    body: "季度预算 4800 万",
    quote: "季度预算 4800 万",
    tail: [{ kind: "human", content: "季度预算 4800 万" }],
    attachments: ["秘密.pdf"],
  };
  const params = notificationTemplateParams({ type: "call", roomId: "r1", payload });
  assert.deepEqual(Object.keys(params).sort(), ["by", "count", "position", "roomName"]);
  const values = stringsOf(params).join("\n");
  assert.equal(values.includes("4800"), false, "no body text reaches the template");
  assert.equal(values.includes("秘密"), false, "no attachment name reaches the template");
  assert.equal(params.position, "42");
  assert.equal(params.roomName, "通知房");
});

test("6.1 a long room title is clipped, not truncated mid-render", () => {
  const params = notificationTemplateParams({ payload: { roomTitle: "一个非常非常长的房间标题用以验证裁剪行为" } }, { maxTitleLen: 8 });
  assert.equal(params.roomName.length, 8);
  assert.equal(params.roomName.endsWith("…"), true);
});

test("6.1 the deep link opens the room at the seq, and a roomless notice has no link", () => {
  assert.deepEqual(notificationDeepLink({ type: "call", roomId: "r1", payload: { seq: 42 } }), {
    path: "/zhiyu/r1?seq=42",
    roomId: "r1",
    seq: 42,
  });
  // Without a position the room still opens (at the tail).
  assert.deepEqual(notificationDeepLink({ type: "invite", roomId: "r 1", payload: {} }), {
    path: "/zhiyu/r%201",
    roomId: "r 1",
    seq: null,
  });
  // A system-wide notice must not invent a destination.
  assert.equal(notificationDeepLink({ type: "budget_warning", roomId: null, payload: { seq: 3 } }), null);
  // A junk seq is not a position.
  assert.equal(notificationDeepLink({ type: "call", roomId: "r1", payload: { seq: "abc" } }).seq, null);
});

test("6.1 the mobile tree does not render notification bodies (source gate, proven red)", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const scan = (dir) => {
    const hits = [];
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (["node_modules", "dist", ".expo", ".taro"].includes(e.name)) continue;
          walk(p);
        } else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
          if (/payload\.(content|text|body|tail|quote)\b/.test(fs.readFileSync(p, "utf8"))) hits.push(p);
        }
      }
    };
    walk(dir);
    return hits;
  };
  // Prove the scanner fails on a violation before asserting today's trees pass.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notify-scan-"));
  fs.writeFileSync(path.join(tmp, "x.tsx"), "const s = n.payload.content;\n");
  assert.equal(scan(tmp).length, 1);
  for (const rel of ["miniapp/src", "app/src"]) {
    const dir = path.join(root, rel);
    if (fs.existsSync(dir)) assert.deepEqual(scan(dir), [], `${rel} must not render a notification body`);
  }
});

// ── 6.2 a badge always has an entry behind it ─────────────────────────────

test("6.2 every unread row is in the panel, even when newer read rows fill the page", async () => {
  const { cli, zhiyu, close } = await boot();
  const roomId = await seedRoom(cli);
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/call`, { target: "b@x" });

  // Fill the newest window with READ rows, so the one unread row is older than
  // everything the default page would return. This is the exact shape that
  // produces "badge says 1, panel shows nothing".
  zhiyu.store.notificationMarkAllRead("b@x");
  const unreadId = zhiyu.store.notificationAdd({ email: "b@x", type: "call", roomId, payload: { roomTitle: "通知房", seq: 7 } });
  const db = zhiyu.store;
  for (let i = 0; i < 105; i += 1) {
    const nid = db.notificationAdd({ email: "b@x", type: "invite", roomId, payload: { roomTitle: "通知房" } });
    db.notificationMarkRead("b@x", nid);
  }

  const inbox = await cli("b@x").get("/api/zhiyu/notifications");
  assert.equal(inbox.body.unread, 1, "one unread");
  const ids = inbox.body.notifications.map((n) => n.id);
  assert.ok(ids.includes(unreadId), "the unread row is in the panel even though 105 read rows are newer");
  // Descending by createdAt for the rendered list.
  const times = inbox.body.notifications.map((n) => n.createdAt);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] <= times[i - 1], "ordered newest first");
  close();
});

test("6.2 the badge is the server's number, and reading the room zeroes it", async () => {
  const { cli, close } = await boot();
  const roomId = await seedRoom(cli);
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/call`, { target: "b@x" });
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/call`, { target: "b@x" });

  const before = await cli("b@x").get("/api/zhiyu/notifications?unread=1");
  assert.equal(before.body.unread, 2);
  assert.equal(before.body.notifications.length, 2, "the unread filter and the count agree");

  const cleared = await cli("b@x").post("/api/zhiyu/notifications/read-all", {});
  assert.equal(cleared.body.unread, 0);

  const after = await cli("b@x").get("/api/zhiyu/notifications");
  assert.equal(after.body.unread, 0);
  assert.ok(after.body.notifications.length >= 2, "the history is still readable, just no longer unread");
  close();
});
