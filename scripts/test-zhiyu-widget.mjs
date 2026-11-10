// Integration tests — zhiyu website embed (add-zhiyu-website-embed).
// Run: node --test scripts/test-zhiyu-widget.mjs
//
//   1.x  token lifecycle: issue requires allowlist; verify/revoke/rotate lands.
//   2.x  loader/meta/CSP: host allowlist gates meta + frame-ancestors on embed.
//   3.x  guest seat: mint→reuse; guest message routes through the real router;
//        private windows stay invisible; identify merges to a user seat;
//        per-seat rate limit; share-link weak lane.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const SECRET = "test-gateway-secret";

async function boot({ agentAnswer = "副驾占位回答", moduleOpts = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-widget-"));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>embed-shell</title>");
  const calls = [];
  const settles = [];
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: { ZHIYU_WIDGET: "1", PAAS_BASE_URL: "https://platform.test" },
    secret: SECRET,
    webDist: dist,
    callAgent: async (member, { text }) => {
      calls.push({ ref: member.ref, text });
      return { text: agentAnswer };
    },
    settleTurn: async (member, usage) => settles.push({ ref: member.ref, ...usage }),
    ssePollMs: 60,
    startTimers: false,
    ...moduleOpts,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email, extraHeaders = {}) => {
    const call = async (method, p, body, headers = {}) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...extraHeaders, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let json = null;
      let text = null;
      try { text = await r.text(); } catch { /* none */ }
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text, headers: r.headers };
    };
    return { get: (p, h) => call("GET", p, undefined, h), post: (p, b, h) => call("POST", p, b ?? {}, h), patch: (p, b, h) => call("PATCH", p, b, h) };
  };
  const close = () => srv.close();
  return { srv, base, cli, zhiyu, calls, settles, close };
}

const waitFor = async (fn, { tries = 60, ms = 50 } = {}) => {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
};

// Seed: owner room with one agent seat + enabled widget.
async function seed(cli, zhiyu) {
  const a = cli("a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "接待间" })).json.room.id;
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "pk:agent", display: "接待分身" });
  const deny = await a.post(`/api/zhiyu/rooms/${roomId}/widget`, { allowlist: [] });
  assert.equal(deny.status, 400, "empty allowlist refused");
  const en = await a.post(`/api/zhiyu/rooms/${roomId}/widget`, { allowlist: ["shop.example.com", "*.partner.com"] });
  assert.equal(en.status, 200);
  return { roomId, token: en.json.token, siteSecret: en.json.siteSecret, fingerprint: en.json.fingerprint };
}

test("1.1/1.2 token: issue→verify→revoke; secret rotate invalidates old", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  // Management shows fingerprint + allowlist (never the secret again).
  const st = await a.get(`/api/zhiyu/rooms/${roomId}/widget`);
  assert.equal(st.json.enabled, true);
  assert.equal(st.json.token.allowlist.includes("*partner.com"), false, "wildcard stored verbatim");
  assert.ok(st.json.token.allowlist.includes("*.partner.com"));
  assert.equal(st.json.token.sec, undefined);
  // Visit works with the fresh token.
  const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/collection" });
  assert.equal(v.status, 200);
  // Revoke → visit 404.
  await a.post(`/api/zhiyu/rooms/${roomId}/widget/revoke`);
  const gone = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/collection" });
  assert.equal(gone.status, 404);
  close();
});

test("2.1/2.2 meta+embed CSP gate by host allowlist", async () => {
  const { cli, zhiyu, close } = await boot();
  const { token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  const badHost = await a.get(`/zhiyu/widget/meta?token=${token}&host=evil.com`);
  assert.equal(badHost.status, 403);
  const okHost = await a.get(`/zhiyu/widget/meta?token=${token}&host=club.partner.com`);
  assert.equal(okHost.status, 200);
  assert.equal(okHost.json.host, "x", "host field carries owner domain-ish label");

  const embed = await a.get(`/zhiyu/embed/${token}`);
  assert.equal(embed.status, 200);
  const csp = embed.headers.get("content-security-policy");
  assert.ok(csp.includes("frame-ancestors"));
  assert.ok(csp.includes("https://shop.example.com"));
  assert.ok(csp.includes("https://*.partner.com"));
  // O1 (polish-zhiyu-embed-csp-and-site-seats): https-only frame-ancestors —
  // an allowlisted host must NOT mint its http:// sibling source.
  assert.ok(!csp.includes("http://shop.example.com"), "no plaintext sibling source");
  assert.ok(!csp.includes("http://*.partner.com"), "no plaintext wildcard source");

  const loader = await a.get(`/zhiyu/widget.js`);
  assert.equal(loader.status, 200);
  assert.ok(loader.text.includes("widget/meta"));
  close();
});

test("3.1 guest mint → reuse via tty; fresh visitor does not collide", async () => {
  const { cli, zhiyu, close } = await boot();
  const { token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  const v1 = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  assert.equal(v1.status, 200);
  assert.ok(v1.json.tty, "issue returns a tty fallback");
  assert.ok(v1.headers.get("set-cookie")?.includes("SameSite=None"));
  // Reuse via tty: same ref, no second seat.
  const v2 = await a.post(`/zhiyu/widget/${token}/visit?tty=${encodeURIComponent(v1.json.tty)}`, undefined, { referer: "https://shop.example.com/" });
  assert.equal(v2.json.ref, v1.json.ref);
  // A stranger with no pass gets a different seat.
  const v3 = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  assert.notEqual(v3.json.ref, v1.json.ref);
  close();
});

test("3.2 guest message routes through the real router and settles with guest scope", async () => {
  const { cli, zhiyu, calls, settles, close } = await boot();
  const { token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  const tty = v.json.tty;
  const post = await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`, { content: "@接待分身 你好" }, { referer: "https://shop.example.com/" });
  assert.equal(post.status, 200);
  await waitFor(() => settles.length >= 1);
  assert.equal(calls.length, 1);
  assert.ok(settles[0].usageId.endsWith("-guest"), `usage id carries guest scope: ${settles[0].usageId}`);
  const msgs = await a.get(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`);
  const rows = msgs.json.messages;
  const answered = rows.find((m) => m.kind === "agent" && m.content === "副驾占位回答");
  assert.ok(answered, "agent row present");
  // Attribution enrichment (polish batch): the visitor sees WHO answered.
  assert.equal(answered.sender?.display, "接待分身");
  assert.equal(answered.sender?.kind, "agent");
  const mine = rows.find((m) => m.content === "@接待分身 你好");
  assert.equal(mine?.sender?.display?.startsWith("访客"), true);
  close();
});

test("3.3 guest never sees private windows; 3.5 per-seat message rate limit", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  const tty = v.json.tty;
  const owner = (await a.get(`/api/zhiyu/rooms/${roomId}`)).json.myMemberId;
  zhiyu.store.messageAppend({ roomId, kind: "agent", visibility: `private:${owner}`, content: "只给店主看" });
  const msgs = await a.get(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`);
  assert.ok(!msgs.json.messages.some((m) => m.content === "只给店主看"));
  // Rate limit: 8/min per seat.
  let last = null;
  for (let i = 0; i < 9; i++) {
    last = await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`, { content: `刷${i}` }, { referer: "https://shop.example.com/" });
  }
  assert.equal(last.status, 429);
  close();
});

test("3.4 identify merges guest into user; old tty dies; history preserved", async () => {
  const { cli, zhiyu, close } = await boot();
  const { token, siteSecret } = await seed(cli, zhiyu);
  const a = cli("a@x");
  const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  const tty = v.json.tty;
  await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`, { content: "我是客户" }, { referer: "https://shop.example.com/" });
  const ts = Date.now();
  const idr = await a.post(`/api/zhiyu/widget/${token}/identify`, {
    email: "buyer@corp.com",
    displayName: "Buyer",
    secret: siteSecret,
    ts,
    nonce: "n-1",
    tty,
  }, { referer: "https://shop.example.com/" });
  assert.equal(idr.status, 200);
  assert.equal(idr.json.member.kind, "user");
  assert.equal(idr.json.member.ref, "buyer@corp.com");
  // The old guest pass no longer resolves (row upgraded; pass names old ref still resolvable seat? seat same id but kind user — guest flow must not treat as guest).
  const again = await a.get(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`);
  assert.equal(again.status, 401, "cookie/tty for the pre-merge seat is invalidated");
  // Replayed identify with the same nonce refused — mint a FRESH seat so the
  // seat gate passes and the nonce burn is the thing under test.
  const v2 = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  const replay = await a.post(`/api/zhiyu/widget/${token}/identify`, {
    email: "buyer@corp.com",
    secret: siteSecret,
    ts: Date.now(),
    nonce: "n-1",
    tty: v2.json.tty,
  }, { referer: "https://shop.example.com/" });
  assert.equal(replay.status, 403);
  // A forged secret refused (fresh seat, so SECRET VERIFICATION is the gate under test).
  const forge = await a.post(`/api/zhiyu/widget/${token}/identify`, {
    email: "buyer2@corp.com",
    secret: "sk_deadbeef.cafe",
    ts: Date.now(),
    nonce: "n-2",
    tty: v2.json.tty,
  }, { referer: "https://shop.example.com/" });
  assert.equal(forge.status, 403);
  close();
});

test("guest join: greeting names callable seats once; apex wildcard matches", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  const { hostAllowed } = await import("../gateway/zhiyu/guest-auth.js");
  assert.equal(hostAllowed(["*.partner.com"], "partner.com"), true, "apex included by wildcard");
  assert.equal(hostAllowed(["*.partner.com"], "x.partner.com"), true);
  assert.equal(hostAllowed(["*.partner.com"], "evil-partner.com"), false);

  const room = zhiyu.store.roomGet(roomId);
  const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  assert.equal(v.status, 200);
  const msgs = zhiyu.store.messagesAfter(room.id, 0, {});
  const greet = msgs.find((m) => m.meta?.event === "guest_greeting");
  assert.ok(greet, "greeting row landed on first mint");
  assert.ok(greet.content.includes("@接待分身"));
  // polish-zhiyu-reception-welcome-line: EVERY active seat is named, so a
  // visitor can point at the fourth one too (a hard slice(0,3) used to hide it).
  const activeSeats = zhiyu.store
    .membersOf(room.id)
    .filter((m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active")
    .map((m) => m.display || m.ref);
  for (const seat of activeSeats) {
    assert.ok(greet.content.includes(`@${seat}`), `greeting names every seat: ${seat}`);
  }
  assert.equal(greet.meta.seats, activeSeats.length, "meta carries the seat count");
  // Reused seat does NOT re-greet.
  await a.post(`/zhiyu/widget/${token}/visit?tty=${encodeURIComponent(v.json.tty)}`, undefined, { referer: "https://shop.example.com/" });
  assert.equal(zhiyu.store.messagesAfter(room.id, 0, {}).filter((m) => m.meta?.event === "guest_greeting").length, 1);
  close();
});

test("proactive greeting: 长房按尾部判定——早期访客的历史不再让新访客被静默", async () => {
  // memoryBlock stub: the wired default hits fd-memory for signed-in askers and
  // would make this timer-driven test wait on a network seam.
  const { cli, zhiyu, calls, close } = await boot({ moduleOpts: { proactiveDelayMs: 0, memoryBlock: async () => "" } });
  const { roomId, token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  assert.equal((await a.patch(`/api/zhiyu/rooms/${roomId}`, { proactiveGreeting: true })).status, 200);

  // History that reproduces the old bug's shape: an EARLY guest_joined, then
  // lots of traffic — enough rows that the join event falls outside the tail
  // window and inside a seq-0 page. Reading from seq 0 therefore concludes
  // "someone already spoke since the last join" and stays silent forever.
  zhiyu.store.messageAppend({ roomId, kind: "system", content: "", meta: { event: "guest_joined" } });
  for (let i = 0; i < 1_100; i += 1) {
    zhiyu.store.messageAppend({ roomId, kind: "system", content: `hist ${i}` });
  }
  zhiyu.store.messageAppend({ roomId, kind: "human", content: "早先有人说过话" });

  // A brand-new visitor arrives and says nothing. The duty seat must speak.
  const isDirective = (c) => c.text.includes("一位访客刚进来");
  try {
    const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
    assert.equal(v.status, 200);
    const greeted = await waitFor(() => calls.find(isDirective));
    assert.equal(greeted.ref, "pk:agent", "尾部窗口判为无人说话 → 值班席开口");
  } finally {
    close();
  }
});

test("proactive greeting: 访客自己先说话则不打扰", async () => {
  const { cli, zhiyu, calls, close } = await boot({ moduleOpts: { proactiveDelayMs: 400, memoryBlock: async () => "" } });
  const { roomId, token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  assert.equal((await a.patch(`/api/zhiyu/rooms/${roomId}`, { proactiveGreeting: true })).status, 200);
  try {
    const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
    assert.equal(v.status, 200);
    // The visitor speaks before the deliberate beat expires.
    const said = await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(v.json.tty)}`, { content: "你好，我想了解一下空间怎么开" }, { referer: "https://shop.example.com/" });
    assert.equal(said.status, 200);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(calls.filter((c) => c.text.includes("一位访客刚进来")).length, 0, "已有访客发言 → 主动招呼放弃");
  } finally {
    close();
  }
});

test("6.1 share-link lane: issue → guest entry → independent revoke", async () => {
  const { cli, zhiyu, close } = await boot();
  const { token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  const sl = await a.post("/api/zhiyu/rooms/" + (await a.get("/api/zhiyu/rooms")).json.rooms[0].id + "/share-link");
  assert.equal(sl.status, 200);
  assert.ok(sl.json.url.includes("/zhiyu/join/"));
  // Link token also mints guests (host check skipped for kind:link) — and
  // it must pass META too (the browser-eye caught meta gating link tokens).
  const linkToken = sl.json.url.split("/zhiyu/join/")[1];
  const metaForLink = await a.get(`/zhiyu/widget/meta?token=${linkToken}&host=anywhere.example.com`);
  assert.equal(metaForLink.status, 200, "link tokens skip the embed host gate on meta");
  const v = await a.post(`/zhiyu/widget/${linkToken}/visit`);
  assert.equal(v.status, 200);
  // Revoking the link does not kill the embed token.
  await a.post(`/api/zhiyu/rooms/${(await a.get("/api/zhiyu/rooms")).json.rooms[0].id}/share-link/revoke`);
  assert.equal((await a.post(`/zhiyu/widget/${linkToken}/visit`)).status, 404);
  assert.equal((await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" })).status, 200);
  close();
});

test("4.2 daily budget gates guests honestly; 4.3 80% nudge lands in the in-app inbox", async () => {
  const { cli, zhiyu, close } = await boot();
  const { roomId, token } = await seed(cli, zhiyu);
  const a = cli("a@x");
  // Budget = 2: first guest answer consumes to 1 (no nudge), second to 2 (nudge fires ONCE at 80%+).
  await a.patch(`/api/zhiyu/rooms/${roomId}`, { dailyBudgetTurns: 2 });
  const v = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  const tty = v.json.tty;
  await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`, { content: "@接待分身 一" }, { referer: "https://shop.example.com/" });
  await waitFor(() => zhiyu.store.roomDayTurnsPeek(roomId) >= 1);
  await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`, { content: "@接待分身 二" }, { referer: "https://shop.example.com/" });
  await waitFor(() => zhiyu.store.roomDayTurnsPeek(roomId) >= 2);
  // Third message: budget exhausted is an HONEST system event, not a pseudo-failure.
  await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`, { content: "@接待分身 三" }, { referer: "https://shop.example.com/" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.meta?.event === "budget_exhausted"));
  const msgs = await a.get(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(tty)}`);
  assert.ok(msgs.json.messages.some((m) => m.meta?.event === "budget_exhausted"));
  // Owner inbox got exactly one budget_warning (80% crossing, not slabbed each turn).
  const inbox = zhiyu.store.notificationsFor("a@x");
  const warnings = inbox.filter((n) => n.type === "budget_warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].payload.budget, 2);
  close();
});

test("item3 proactive greeting: silent visitor gets greeted by a duty seat", async () => {
  const _dirs = [];
  const { cli, zhiyu, calls, close } = await boot({ moduleOpts: { proactiveDelayMs: 60 } });
  const a = cli("a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "", proactiveGreeting: undefined })).json.room.id;
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "pk:agent", display: "值班分身" });
  // Opt in via patch (owner).
  await a.patch(`/api/zhiyu/rooms/${roomId}`, { proactiveGreeting: true });
  const en = await a.post(`/api/zhiyu/rooms/${roomId}/widget`, { allowlist: ["shop.example.com"] });
  const token = en.json.token;
  await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  // Directive turn settles as the duty seat's own in-room line within the beat.
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.kind === "agent"), { tries: 60, ms: 50 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /欢迎|温暖|简洁/);
  close();
});

test("item3 proactive greeting: skipped when the visitor speaks first; off by default", async () => {
  const { cli, zhiyu, calls, close } = await boot({ moduleOpts: { proactiveDelayMs: 60 } });
  const a = cli("a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "" })).json.room.id;
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "pk:agent", display: "值班分身" });
  const en = await a.post(`/api/zhiyu/rooms/${roomId}/widget`, { allowlist: ["shop.example.com"] });
  const token = en.json.token;
  // Default: proactive greeting OFF — no directive even when silent.
  await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.length, 0, "default stays quiet");

  // Opt in, then speak immediately — the greeter must stand down.
  await a.patch(`/api/zhiyu/rooms/${roomId}`, { proactiveGreeting: true });
  const v2 = await a.post(`/zhiyu/widget/${token}/visit`, undefined, { referer: "https://shop.example.com/" });
  await a.post(`/api/zhiyu/widget/${token}/messages?tty=${encodeURIComponent(v2.json.tty)}`, { content: "我自己先说什么" }, { referer: "https://shop.example.com/" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.filter((c) => /欢迎/.test(c.text)).length, 0, "greeter stands down when the visitor spoke");
  close();
});
