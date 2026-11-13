// A guest on a phone (openspec: add-zhiyu-mobile-clients, 6.3).
//
// The guest lane is the one place where "same semantics on mobile" is not about
// the cursor at all — it is about authority. A visitor who arrives through a
// share link or a widget token gets a seat with `historyGrant: 'join_from'` and
// must be exactly as limited on a phone as in a browser: the same visible
// window, the same writes, and no private window at all.
//
// The failure being prevented: mobile adds a convenient guest surface (a
// "message the host privately" button, a room-settings sheet) because the phone
// felt cramped — and that surface has no counterpart in the web's permission
// check, so it can only ever be more permissive.
//
//   node --test scripts/test-zhiyu-guest-mobile.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const OPEN = [];
test.after(() => Promise.all(OPEN.map((srv) => new Promise((r) => srv.close(r)))));

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guest-mobile-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: path.join(tmp, "data"),
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: { ZHIYU_WIDGET: "1" },
    secret: "guest-mobile-test-secret",
    callAgent: async (member) => ({ text: `（${member.display}的回答）` }),
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  OPEN.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;

  const raw = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: r.status, body: parsed, setCookie: r.headers.get("set-cookie") ?? "" };
  };
  return { zhiyu, base, raw, close: () => srv.close() };
}

/** Owner + a share link; the guest's cookie comes back from /visit. */
async function seedWithLink(raw, _zhiyu) {
  const created = await raw("POST", "/api/zhiyu/rooms", { body: { title: "访客房" }, headers: { "x-user": "a@x" } });
  const roomId = created.body.room.id;
  const link = await raw("POST", `/api/zhiyu/rooms/${roomId}/share-link`, { body: {}, headers: { "x-user": "a@x" } });
  const token = link.body.token;
  const visited = await raw("POST", `/zhiyu/widget/${token}/visit`, { body: {} });
  assert.equal(visited.status, 200, "the link mints a guest seat");
  const cookie = String(visited.setCookie).split(";")[0];
  assert.match(cookie, /^zy_guest=/, "the seat travels as a guest pass");
  return { roomId, token, guest: { cookie }, owner: { "x-user": "a@x" } };
}

// ── 6.3 the guest reads and writes exactly what a guest may ───────────────

test("6.3 a guest joins by link, pages the same window the in-room reader sees, and can speak", async () => {
  const { raw, zhiyu, close } = await boot();
  const { roomId, token, guest, owner } = await seedWithLink(raw, zhiyu);

  await raw("POST", `/api/zhiyu/rooms/${roomId}/messages`, { body: { content: "公开的一" }, headers: owner });
  await raw("POST", `/api/zhiyu/rooms/${roomId}/messages`, { body: { content: "公开的二" }, headers: owner });

  // Paging and the polling increment must agree, exactly as they do in-room.
  const paged = await raw("GET", `/api/zhiyu/widget/${token}/messages?tail=50`, { headers: guest });
  assert.equal(paged.status, 200);
  const polled = await raw("GET", `/api/zhiyu/widget/${token}/stream?after=0&wait=0`, { headers: guest });
  assert.equal(polled.status, 200);
  assert.deepEqual(
    polled.body.messages.map((m) => m.seq),
    paged.body.messages.map((m) => m.seq),
    "the polling lane and the paging lane answer identically for a guest",
  );
  assert.ok(paged.body.messages.some((m) => m.content === "公开的二"));

  // Speaking works, and the row is attributed to the guest seat.
  const spoke = await raw("POST", `/api/zhiyu/widget/${token}/messages`, { body: { content: "访客说一句" }, headers: guest });
  assert.equal(spoke.status, 200);
  assert.equal(spoke.body.message.kind, "human");
  assert.equal(spoke.body.message.senderMemberId, zhiyu.store.membersOf(roomId).find((m) => m.kind === "guest").id);

  // And it comes back on the increment, advancing the cursor.
  const next = await raw("GET", `/api/zhiyu/widget/${token}/stream?after=${polled.body.cursor}&wait=0`, { headers: guest });
  assert.equal(next.body.messages.at(-1).content, "访客说一句");
  assert.ok(next.body.cursor > polled.body.cursor);
  close();
});

test("6.3 an empty increment holds for the wait window and returns the same cursor", async () => {
  const { raw, zhiyu, close } = await boot();
  const { token, guest } = await seedWithLink(raw, zhiyu);
  const first = await raw("GET", `/api/zhiyu/widget/${token}/stream?after=0&wait=0`, { headers: guest });
  const started = Date.now();
  const empty = await raw("GET", `/api/zhiyu/widget/${token}/stream?after=${first.body.cursor}&wait=150`, { headers: guest });
  const elapsed = Date.now() - started;
  assert.deepEqual(empty.body.messages, []);
  assert.equal(empty.body.cursor, first.body.cursor, "an empty increment never moves the cursor");
  assert.ok(elapsed >= 120, `it held (${elapsed}ms)`);
  const bad = await raw("GET", `/api/zhiyu/widget/${token}/stream?after=0&wait=abc`, { headers: guest });
  assert.equal(bad.status, 400);
  close();
});

// ── 6.3 the private window stays unreachable ──────────────────────────────

test("6.3 a guest has no private window: no entry, and the in-room endpoints refuse", async () => {
  const { raw, zhiyu, close } = await boot();
  const { roomId, token, guest } = await seedWithLink(raw, zhiyu);

  // Something in the OWNER's private window.
  const ownerSeat = zhiyu.store.membersOf(roomId).find((m) => m.kind === "user" && m.ref === "a@x");
  zhiyu.store.messageAppend({
    roomId,
    kind: "human",
    senderMemberId: ownerSeat.id,
    visibility: `private:${ownerSeat.id}`,
    content: "只给我看的",
  });

  // Not visible on either guest transport.
  for (const q of ["messages?tail=100", "messages?after=0", "stream?after=0&wait=0"]) {
    const out = await raw("GET", `/api/zhiyu/widget/${token}/${q}`, { headers: guest });
    assert.equal(out.status, 200, q);
    assert.equal(
      out.body.messages.some((m) => m.content === "只给我看的"),
      false,
      `${q}: another member's private row must not reach a guest`,
    );
  }

  // The private-window WRITE is not on the guest lane at all…
  const privateOnWidget = await raw("POST", `/api/zhiyu/widget/${token}/private`, { body: { content: "偷偷说" }, headers: guest });
  assert.equal(privateOnWidget.status, 404, "no private-window endpoint on the guest lane");

  // …and the in-room one refuses the guest outright. A guest pass is a cookie,
  // not a user session, so the refusal is 401 at the door (before any room
  // lookup) — the phone cannot promote a visitor into a user seat by trying.
  const privateInRoom = await raw("POST", `/api/zhiyu/rooms/${roomId}/private`, { body: { content: "偷偷说" }, headers: guest });
  assert.equal(privateInRoom.status, 401, "a guest pass is not a user session");

  // Same for the other web-only surfaces: no guest capability that web lacks.
  for (const [method, p, body] of [
    ["POST", `/api/zhiyu/rooms/${roomId}/deeplink`, { purpose: "private_window" }],
    ["GET", `/api/zhiyu/rooms/${roomId}/messages?tail=10`, undefined],
    ["POST", `/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "x@x" }],
    ["POST", `/api/zhiyu/rooms/${roomId}/call`, { target: "a@x" }],
  ]) {
    const out = await raw(method, p, { body, headers: guest });
    assert.equal(out.status, 401, `${method} ${p} must not be reachable with a guest pass`);
  }
  close();
});

test("6.3 no guest-only endpoint exists that web does not have", () => {
  // The guest lane is a SEAT, not a second product: four read/write faces plus
  // identify. Any new /api/zhiyu/widget/* route has to be a deliberate edit to
  // this list, which is the moment to ask "does web have this too?".
  const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "gateway/zhiyu/index.js"), "utf8");
  const routes = [...src.matchAll(/app\.(get|post|patch|delete)\("(\/zhiyu\/widget[^"]*|\/api\/zhiyu\/widget[^"]*|\/zhiyu\/join[^"]*)"/g)].map(
    (m) => `${m[1].toUpperCase()} ${m[2]}`,
  );
  assert.deepEqual(
    routes.sort(),
    [
      "GET /zhiyu/join/:token",
      "GET /zhiyu/widget.js",
      "GET /zhiyu/widget/meta",
      "GET /api/zhiyu/widget/:token/events",
      "GET /api/zhiyu/widget/:token/messages",
      "GET /api/zhiyu/widget/:token/stream",
      "POST /api/zhiyu/widget/:token/identify",
      "POST /api/zhiyu/widget/:token/messages",
      "POST /zhiyu/widget/:token/visit",
    ].sort(),
    "the guest lane is a seat, not a second surface area",
  );
});
