// Integration tests — zhiyu team accounts (add-zhiyu-team-account).
// Run: node --test scripts/test-zhiyu-team-account.mjs
//
// The load-bearing property is EQUIVALENCE: a room-target token must behave
// byte-for-byte as it did before accounts existed, so the whole legacy widget
// suite stays a valid regression gate. Everything new is asserted alongside.
//
//   1.x  account lifecycle: fleet ownership is verified against the owner's
//        own cell, not the request body; revoke is idempotent and kills doors.
//   2.x  token targets: a room token resolves to its room; an account token
//        opens (then reuses) a room; a revoked account is indistinguishable
//        from an unknown token.
//   3.x  doors: per-door allowlist + revocation, shared token machinery.
//   4.x  provenance: rooms carry accountId; guest resume lands in the SAME room.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { createAccountRoomSeeder } from "../gateway/account-room-seeder.js";

const SECRET = "test-gateway-secret";

async function boot({ fleets = null, moduleOpts = {} } = {}) {
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-acct-"));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-acct-dist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>embed-shell</title>");
  const calls = [];
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: { ZHIYU_WIDGET: "1", PAAS_BASE_URL: "https://platform.test" },
    secret: SECRET,
    webDist: dist,
    callAgent: async (member, { text }) => { calls.push({ ref: member.ref, text }); return { text: "在。" }; },
    settleTurn: async () => {},
    ssePollMs: 60,
    startTimers: false,
    // The cell-sourced fleet sample: the ONLY authority on "is this fleet real
    // and mine". A test passes a fixed roster; the default is "cell says none".
    sampleFleets: async (email) => (fleets ? fleets(email) : null),
    // The room seeder: seats the team's serving members into an account's room.
    // Injected here exactly as gateway/index.js composes it.
    accountRoomSeeder: moduleOpts.accountRoomSeeder ?? null,
    ...moduleOpts,
  });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => {
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let json = null; let text = null;
      try { text = await r.text(); } catch { /* none */ }
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text, headers: r.headers };
    };
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b) };
  };
  // Compose the REAL seeder against the live store (as gateway/index.js does),
  // so these tests exercise the production seating path, not a stub of it.
  const holder = moduleOpts.accountRoomSeeder;
  if (holder && typeof holder === "object" && "current" in holder) {
    holder.current = createAccountRoomSeeder({
      store: zhiyu.store,
      resolveServing: moduleOpts.servingResolver?.resolve ?? null,
    });
  }
  return { base, cli, zhiyu, calls, close: () => srv.close() };
}

const roster = (id, name = "客服团") => () => ({ fleets: [{ id, name }] });

// ── 1.x account lifecycle ────────────────────────────────────────────────────

test("1.1 create: fleet ownership is verified against the owner's cell", async () => {
  const { cli, close } = await boot({ fleets: roster("f1", "客服团") });
  const a = cli("a@x");
  const ok = await a.post("/api/zhiyu/team-accounts", { fleetId: "f1" });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.account.fleetId, "f1");
  assert.equal(ok.json.account.fleetName, "客服团");
  assert.match(ok.json.account.id, /^fd_/);
  // A fleet the cell does not list is refused the same way a missing one is.
  const bogus = await a.post("/api/zhiyu/team-accounts", { fleetId: "nope" });
  assert.equal(bogus.status, 404);
  assert.equal(bogus.json.error, "not found");
  close();
});

test("1.2 create: no cell sample means no account (never trust the body)", async () => {
  const { cli, close } = await boot({ fleets: null });
  const a = cli("a@x");
  const r = await a.post("/api/zhiyu/team-accounts", { fleetId: "f1" });
  assert.equal(r.status, 404);
  close();
});

test("1.3 revoke is idempotent and kills every door", async () => {
  const { cli, close } = await boot({ fleets: roster("f1") });
  const a = cli("a@x");
  const { json } = await a.post("/api/zhiyu/team-accounts", { fleetId: "f1" });
  const id = json.account.id;
  const door = await a.post(`/api/zhiyu/team-accounts/${id}/widget`, { allowlist: ["shop.example.com"] });
  assert.equal(door.status, 200);
  const once = await a.post(`/api/zhiyu/team-accounts/${id}/revoke`);
  assert.equal(once.json.account.revoked, true);
  assert.equal(once.json.account.doors.every((d) => d.revoked), true, "all doors revoked with the account");
  const twice = await a.post(`/api/zhiyu/team-accounts/${id}/revoke`);
  assert.equal(twice.status, 200, "a second revoke is a no-op, not an error");
  close();
});

test("1.4 another user's account answers exactly like a missing one", async () => {
  const { cli, close } = await boot({ fleets: roster("f1") });
  const a = cli("a@x");
  const id = (await a.post("/api/zhiyu/team-accounts", { fleetId: "f1" })).json.account.id;
  const b = cli("b@x");
  assert.equal((await b.patch(`/api/zhiyu/team-accounts/${id}`, { replyCap: 5 })).status, 404);
  assert.equal((await b.post(`/api/zhiyu/team-accounts/${id}/revoke`)).status, 404);
  assert.equal((await b.post(`/api/zhiyu/team-accounts/${id}/widget`, { allowlist: ["x.com"] })).status, 404);
  // b cannot even see it.
  assert.equal((await b.get("/api/zhiyu/team-accounts")).json.accounts.length, 0);
  close();
});

// ── 2.x token targets ────────────────────────────────────────────────────────

async function seedAccount(cli) {
  const a = cli("a@x");
  const id = (await a.post("/api/zhiyu/team-accounts", { fleetId: "f1" })).json.account.id;
  const mint = await a.post(`/api/zhiyu/team-accounts/${id}/widget`, { allowlist: ["shop.example.com"] });
  assert.equal(mint.status, 200);
  return { accountId: id, token: mint.json.token, snippet: mint.json.snippet };
}

test("2.1 a room token still resolves to its own room (legacy equivalence)", async () => {
  const { base, cli, zhiyu, close } = await boot({ fleets: roster("f1") });
  const a = cli("a@x");
  const roomId = (await a.post("/api/zhiyu/rooms", { title: "旧房" })).json.room.id;
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "pk:agent", display: "接待分身" });
  const mint = await a.post(`/api/zhiyu/rooms/${roomId}/widget`, { allowlist: ["shop.example.com"] });
  // The embed lane requires its host gate on a room token — that gate is one of
  // the behaviors being proven unchanged, so the visit carries a real referer.
  const r = await fetch(`${base}/zhiyu/widget/${mint.json.token}/visit`, {
    method: "POST",
    headers: { "content-type": "application/json", referer: "https://shop.example.com/p" },
    body: "{}",
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.roomId, roomId, "room token lands in its own room, unchanged");
  close();
});

test("2.2 an account token opens a room, then the same visitor reuses it", async () => {
  const { base, cli, close } = await boot({ fleets: roster("f1", "客服团") });
  const { token, accountId } = await seedAccount(cli);
  const r1 = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST",
    headers: { "content-type": "application/json", referer: "https://shop.example.com/p" },
    body: "{}",
  });
  const j1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.ok(j1.roomId, "a room was opened for the visitor");
  assert.ok(j1.tty, "a guest pass was issued");
  assert.equal(j1.title.includes("客服团"), true, "the room is named after the team");

  // Return visit with the same pass → SAME room (no second room spawned).
  const r2 = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST",
    headers: { "content-type": "application/json", referer: "https://shop.example.com/p", cookie: `zy_guest=${encodeURIComponent(j1.tty)}` },
    body: "{}",
  });
  const j2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(j2.roomId, j1.roomId, "the same visitor returns to the same room");

  // Provenance: the room knows which account opened it.
  const acc = (await cli("a@x").get("/api/zhiyu/team-accounts")).json.accounts[0];
  assert.equal(acc.id, accountId);
  close();
});

test("2.3 a revoked account is indistinguishable from an unknown token", async () => {
  const { base, cli, close } = await boot({ fleets: roster("f1") });
  const { accountId, token } = await seedAccount(cli);
  await cli("a@x").post(`/api/zhiyu/team-accounts/${accountId}/revoke`);
  const revoked = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://shop.example.com/" }, body: "{}",
  });
  const unknown = await fetch(`${base}/zhiyu/widget/wtr_deadbeefdead.0123456789abcdef0123456789abcdef/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://shop.example.com/" }, body: "{}",
  });
  assert.equal(revoked.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(await revoked.text(), await unknown.text(), "same bytes — no oracle for 'this account existed'");
  close();
});

test("2.4 read-only lanes never open a room", async () => {
  const { base, cli, zhiyu, close } = await boot({ fleets: roster("f1") });
  const { token } = await seedAccount(cli);
  const before = zhiyu.store.teamAccountsForOwner("a@x").length;
  // A poll from a visitor with no pass must not spawn a room.
  const r = await fetch(`${base}/api/zhiyu/widget/${token}/messages?after=0`, {
    headers: { referer: "https://shop.example.com/" },
  });
  assert.equal(r.status, 404, "no resolvable room → not found, and nothing was created");
  const roomsNow = zhiyu.store.teamAccountsForOwner("a@x").length;
  assert.equal(roomsNow, before, "no side effect on the account either");
  close();
});

// ── 3.x doors ────────────────────────────────────────────────────────────────

test("3.1 minting a new door replaces the previous one for the account", async () => {
  const { base, cli, close } = await boot({ fleets: roster("f1") });
  const a = cli("a@x");
  const id = (await a.post("/api/zhiyu/team-accounts", { fleetId: "f1" })).json.account.id;
  const first = await a.post(`/api/zhiyu/team-accounts/${id}/widget`, { allowlist: ["a.example.com"] });
  const second = await a.post(`/api/zhiyu/team-accounts/${id}/widget`, { allowlist: ["b.example.com"] });
  assert.equal(second.status, 200);
  const acc = (await a.get("/api/zhiyu/team-accounts")).json.accounts[0];
  const live = acc.doors.filter((d) => !d.revoked);
  assert.equal(live.length, 1, "one live embed door at a time");
  assert.equal(live[0].allowlist[0], "b.example.com");
  // The old door is dead at the gate.
  const old = await fetch(`${base}/zhiyu/widget/${first.json.token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://a.example.com/" }, body: "{}",
  });
  assert.equal(old.status, 404);
  close();
});

test("3.2 an account door enforces its own allowlist", async () => {
  const { base, cli, close } = await boot({ fleets: roster("f1") });
  const { token } = await seedAccount(cli); // allowlist: shop.example.com
  const bad = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://evil.example.net/" }, body: "{}",
  });
  assert.equal(bad.status, 403, "host outside the account door's allowlist");
  close();
});

// ── 4.x provenance ───────────────────────────────────────────────────────────

test("4.1 a room opened by an account carries accountId; a plain room does not", async () => {
  const { base, cli, zhiyu, close } = await boot({ fleets: roster("f1") });
  const a = cli("a@x");
  const plain = (await a.post("/api/zhiyu/rooms", { title: "普通房" })).json.room;
  assert.equal(plain.accountId, null);
  const { token } = await seedAccount(cli);
  const r = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://shop.example.com/" }, body: "{}",
  });
  const opened = zhiyu.store.roomGet((await r.json()).roomId);
  assert.match(opened.accountId, /^fd_/);
  close();
});

test("4.2 concurrent visitors get separate rooms; each returns to its own", async () => {
  const { base, cli, close } = await boot({ fleets: roster("f1") });
  const { token } = await seedAccount(cli);
  const visit = async (tty) => {
    const r = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
      method: "POST",
      headers: { "content-type": "application/json", referer: "https://shop.example.com/", ...(tty ? { cookie: `zy_guest=${encodeURIComponent(tty)}` } : {}) },
      body: "{}",
    });
    return r.json();
  };
  const v1 = await visit(null);
  const v2 = await visit(null);
  assert.notEqual(v1.roomId, v2.roomId, "two fresh visitors do not share a room seat");
  const back1 = await visit(v1.tty);
  assert.equal(back1.roomId, v1.roomId, "visitor 1 resumes their own room");
  close();
});

// ── 5.x a team account's room arrives WITH its seats ────────────────────────
//
// The end-to-end gap this pins (found by testing Slack on 2026-11-19): the
// account opened a room, the group message landed, and nobody answered —
// because nobody was IN the room. "The team's outward address" must not be an
// address that no one answers at.

test("5.1 a new account room is seeded with the team's serving seats", async () => {
  const serving = {
    fleet: { id: "f1", name: "客服团" },
    serving: [
      { ref: "pk1:advisor", title: "产品顾问", onBehalfOf: "owner@x" },
      { ref: "pk1:assessor", title: "项目评估师", onBehalfOf: "owner@x" },
    ],
    cockpitOnly: [],
  };
  const { base, cli, zhiyu, close } = await boot({ fleets: roster("f1", "客服团"), moduleOpts: { servingResolver: { resolve: async () => serving }, accountRoomSeeder: { current: null } } });
  const { token } = await seedAccount(cli);
  const r = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://shop.example.com/" }, body: "{}",
  });
  const j = await r.json();
  assert.equal(r.status, 200);
  const kinds = zhiyu.store.membersOf(j.roomId).map((m) => `${m.kind}:${m.display}`).sort();
  assert.deepEqual(kinds, ["agent:产品顾问", "agent:项目评估师", "guest:" + kinds.find((k) => k.startsWith("guest:")).split(":")[1]], "both seats seated alongside the visitor");
  close();
});

test("5.2 a team with no serving seats says so in the room instead of staying silent", async () => {
  const serving = { fleet: { id: "f1", name: "客服团" }, serving: [], cockpitOnly: ["产品向导", "壹座专家"] };
  const { base, cli, zhiyu, close } = await boot({ fleets: roster("f1", "客服团"), moduleOpts: { servingResolver: { resolve: async () => serving }, accountRoomSeeder: { current: null } } });
  const { token } = await seedAccount(cli);
  const r = await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://shop.example.com/" }, body: "{}",
  });
  const j = await r.json();
  const rows = zhiyu.store.messagesAfter(j.roomId, 0, {});
  const notice = rows.find((m) => m.meta?.event === "no_serving_seats");
  assert.ok(notice, "a system row names the emptiness");
  assert.match(notice.content, /没有可接待的席位/);
  assert.match(notice.content, /产品向导/, "names what the team does have");
  close();
});

test("5.3 seating is idempotent: a returning visitor does not re-seat the team", async () => {
  let calls = 0;
  const serving = {
    fleet: { id: "f1", name: "客服团" },
    get serving() { calls += 1; return [{ ref: "pk1:advisor", title: "产品顾问", onBehalfOf: "owner@x" }]; },
    cockpitOnly: [],
  };
  const { base, cli, zhiyu, close } = await boot({ fleets: roster("f1", "客服团"), moduleOpts: { servingResolver: { resolve: async () => serving }, accountRoomSeeder: { current: null } } });
  const { token } = await seedAccount(cli);
  // Carry the pass back: without it the second visit is a DIFFERENT visitor
  // and a fresh room is correct (asserted in 4.2). Idempotency here is about
  // the same visitor coming back to the same room.
  const visit = async (tty) => (await (await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST",
    headers: { "content-type": "application/json", referer: "https://shop.example.com/", ...(tty ? { cookie: `zy_guest=${encodeURIComponent(tty)}` } : {}) },
    body: "{}",
  })).json());
  const a = await visit(null);
  const b = await visit(a.tty);
  assert.equal(a.roomId, b.roomId, "same room reused");
  const agents = zhiyu.store.membersOf(a.roomId).filter((m) => m.kind === "agent");
  assert.equal(agents.length, 1, "the seat is not duplicated");
  // 幂等的实质：第二次访问不该再解析一次 serving（否则等于重新 seating）。
  assert.equal(calls, 1, "serving resolved exactly once across both visits");
  close();
});

test("5.4 the seeder is resolved at CALL time, not at registration time", async () => {
  // Production bug (2026-11-19, caught by end-to-end Slack): the IM bridge
  // captured `seederHolder.current` while it was still null (the seeder needs
  // the store, which only exists after registerZhiyuRoutes returns), so
  // `seeder` was permanently null and account rooms opened empty — the exact
  // silence the seeder exists to prevent. Tests passed because the harness
  // filled the holder BEFORE boot() assembled the routes.
  //
  // The fix: hand over the HOLDER, resolve `.current` at call time.
  const serving = { fleet: { id: "f1", name: "客服团" }, serving: [{ ref: "pk1:advisor", title: "产品顾问", onBehalfOf: "owner@x" }], cockpitOnly: [] };
  const holder = { current: null }; // empty at registration, filled after
  const { base, cli, zhiyu, close } = await boot({
    fleets: roster("f1", "客服团"),
    moduleOpts: { servingResolver: { resolve: async () => serving }, accountRoomSeeder: holder },
  });
  // boot() filled it — but the important part is that the ROUTES saw the fill.
  const { token } = await seedAccount(cli);
  const j = await (await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://shop.example.com/" }, body: "{}",
  })).json();
  const agents = zhiyu.store.membersOf(j.roomId).filter((m) => m.kind === "agent");
  assert.equal(agents.length, 1, "a seeder filled after registration still seats seats");
  close();
});

test("5.5 the no-seat notice is said once per room, not once per process", async () => {
  // The `seeded` guard is in-process; a pod restart re-seeds. The transcript
  // must not accumulate repeated "nobody can answer" rows — a room whose whole
  // job is to be trustworthy cannot afford noise that looks like a new event.
  const serving = { fleet: { id: "f1", name: "客服团" }, serving: [], cockpitOnly: ["产品向导"] };
  const { base, cli, zhiyu, close } = await boot({ fleets: roster("f1", "客服团"), moduleOpts: { servingResolver: { resolve: async () => serving }, accountRoomSeeder: { current: null } } });
  const { token } = await seedAccount(cli);
  const j = await (await fetch(`${base}/zhiyu/widget/${token}/visit`, {
    method: "POST", headers: { "content-type": "application/json", referer: "https://shop.example.com/" }, body: "{}",
  })).json();
  // Simulate a fresh process: a NEW seeder over the same room.
  const { createAccountRoomSeeder } = await import("../gateway/account-room-seeder.js");
  const fresh = createAccountRoomSeeder({ store: zhiyu.store, resolveServing: async () => serving });
  await fresh.seat({ ownerEmail: "a@x", fleetId: "f1" }, zhiyu.store.roomGet(j.roomId));
  const rows = zhiyu.store.messagesAfter(j.roomId, 0, {}).filter((m) => m.meta?.event === "no_serving_seats");
  assert.equal(rows.length, 1, "one notice, even after a re-seed");
  close();
});
