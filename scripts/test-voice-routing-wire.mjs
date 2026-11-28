// Voice routing on the wire (openspec: add-voice-routing, 3.1 / 3.2 / 3.4 / 4.1
// / 5.3).
//
// The decision matrix is proved in scripts/test-voice-routing-priority.mjs. What
// is only provable here is the WIRING, and its most important property is a
// negative one: with no seam, or a seam that declines, the room must behave
// exactly as it did before this change. The existing zhiyu suite covers the
// legacy path; this file pins the opt-in path and proves the two do not leak
// into each other.
//
//   node --test scripts/test-voice-routing-wire.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { after } from "node:test";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { decideAddressee } from "../gateway/zhiyu/voice-router.js";

/**
 * Boot a room with an optional voice-routing seam.
 *
 * `state` is the mutable holder the seam reads: seats and the speaker's
 * attribution only exist after seeding, and a seam that captured them earlier
 * would be testing a decision nothing ever made.
 */
const OPEN = []; // every booted server; closed in one place so a failed
// assertion cannot leave a listener behind and hang the runner.
after(() => Promise.all(OPEN.map((srv) => new Promise((r) => srv.close(r)))));

async function boot({ seam = null, agentScript = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-voice-route-"));
  const calls = [];
  const usage = [];
  const state = { members: [], attribution: null };

  const callAgent = async (member, { text, contextId }) => {
    calls.push({ ref: member.ref, text, contextId });
    const script = agentScript[member.ref] ?? { answer: `（${member.display}的回答）` };
    // A slow seat is what makes the "not yet started" window exist at all — the
    // router dispatches sequentially, so a cancel can only land while a turn is
    // in flight.
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    if (script.throw) throw new Error(script.throw);
    return { text: script.answer };
  };

  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent,
    settleTurn: (member, info) => usage.push({ ref: member.ref, usageId: info.usageId, minutes: info.minutes }),
    voiceRoute: seam ? ({ agents }) => seam({ agents, state }) : null,
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
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b) };
  };
  return { base, cli, zhiyu, calls, usage, state, close: () => srv.close() };
}

async function waitFor(fn, { tries = 80, ms = 40 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
}

/** Settle: give in-flight sequential dispatch a moment, then read. */
const settle = () => new Promise((r) => setTimeout(r, 200));

async function seedRoom(cli, zhiyu, ownerEmail, seats) {
  const created = await cli(ownerEmail).post("/api/zhiyu/rooms", { title: "语音派发" });
  const roomId = created.body.room.id;
  const members = seats.map((s) =>
    zhiyu.store.memberAdd({
      roomId,
      kind: s.kind ?? "agent",
      ref: s.ref,
      display: s.display ?? s.ref,
      onBehalfOf: s.onBehalfOf ?? null,
    }),
  );
  return { roomId, members };
}

/** One team per seat, owned by that seat — how the seam reports room teams. */
function teamsFor(members) {
  return members.map((m) => ({
    id: `team-${m.id}`,
    ref: `${m.ref}/team`,
    display: `${m.display}的团队`,
    names: [`${m.display}团队`],
    ownerMemberId: m.id,
    // The room team knows the seat that answers for it. Production reads this
    // from the A2A card's binding; the test states it outright.
    seatId: m.id,
    tags: [m.ref],
    visible: true,
    callable: true,
  }));
}

/** The standard seam: decide from the room's own seats plus the test's state. */
function standardSeam({ agents, state }) {
  return decideAddressee({
    utterance: state.utterance ?? "",
    attribution: state.attribution,
    roomTeams: teamsFor(state.members),
    roomSeats: agents.map((a) => ({ id: a.id, kind: a.kind, display: a.display, names: [a.display] })),
    roomPolicy: state.policy ?? {},
  });
}

// ── 3.1 the switch, both ways ─────────────────────────────────────────────

test("3.1 no seam: an unaddressed message still broadcasts (behaviour unchanged)", async () => {
  const { cli, zhiyu, calls, close } = await boot();
  const { roomId } = await seedRoom(cli, zhiyu, "a@x", [
    { ref: "one", display: "One" },
    { ref: "two", display: "Two" },
  ]);
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "大家都看看" });
  await waitFor(() => calls.length >= 2);
  await settle();
  assert.deepEqual(calls.map((c) => c.ref).sort(), ["one", "two"]);
  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.equal(
    rows.some((m) => m.meta?.event === "route_decision"),
    false,
    "no decision row when the seam is absent — the room must look exactly as before",
  );
  close();
});

test("3.1 a seam that declines (null) leaves the legacy broadcast in place", async () => {
  const { cli, zhiyu, calls, close } = await boot({ seam: () => null });
  const { roomId } = await seedRoom(cli, zhiyu, "a@x", [
    { ref: "one", display: "One" },
    { ref: "two", display: "Two" },
  ]);
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "大家都看看" });
  await waitFor(() => calls.length >= 2);
  await settle();
  assert.deepEqual(calls.map((c) => c.ref).sort(), ["one", "two"]);
  close();
});

test("3.1 a throwing seam degrades to the legacy path instead of dropping the message", async () => {
  const { cli, zhiyu, calls, close } = await boot({
    seam: () => {
      throw new Error("router exploded");
    },
  });
  const { roomId } = await seedRoom(cli, zhiyu, "a@x", [
    { ref: "one", display: "One" },
    { ref: "two", display: "Two" },
  ]);
  await cli("a@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "大家都看看" });
  await waitFor(() => calls.length >= 2);
  assert.deepEqual(calls.map((c) => c.ref).sort(), ["one", "two"], "a human message is never lost to a router bug");
  close();
});

// ── 3.2 default recipient ─────────────────────────────────────────────────

test("3.2 attribution wakes only the speaker's own team; the others cost nothing", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "zhang", display: "张三" },
    { ref: "li", display: "李四" },
    { ref: "wang", display: "王五" },
  ]);
  ctx.state.members = seeded.members;
  // The words match nobody's tags: only the attribution path can answer.
  ctx.state.utterance = "这个事我这边处理";
  ctx.state.attribution = { certainty: "bound", memberId: seeded.members[0].id };

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "这个事我这边处理" });
  await waitFor(() => ctx.calls.length >= 1);
  await settle();
  assert.deepEqual(ctx.calls.map((c) => c.ref), ["zhang"], "exactly one seat was woken");
  assert.equal(ctx.usage.length, 1, "one billed turn, not three");
  ctx.close();
});

test("3.2 an anonymous speaker with no other signal wakes nobody and records why", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "zhang", display: "张三" },
    { ref: "li", display: "李四" },
  ]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "嗯……那个";
  ctx.state.attribution = { certainty: "anonymous" };

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "嗯……那个" });
  const row = await waitFor(() =>
    ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.meta?.event === "route_decision"),
  );
  await settle();
  assert.equal(ctx.calls.length, 0, "an uncertain speaker never broadcasts");
  assert.equal(row.meta.kind, "needs_confirmation");
  assert.match(row.meta.reason, /归属不确定/);
  ctx.close();
});

// ── 3.4 meeting mode ──────────────────────────────────────────────────────

test("3.4 an explicit two-name message is still answered twice under meeting mode", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "zhang", display: "张三" },
    { ref: "li", display: "李四" },
    { ref: "wang", display: "王五" },
  ]);
  ctx.state.members = seeded.members;
  ctx.state.policy = { meetingMode: true };
  ctx.state.utterance = "@张三 @李四 预算和排期都说说";

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "@张三 @李四 预算和排期都说说" });
  await waitFor(() => ctx.calls.length >= 2);
  await settle();
  assert.deepEqual(ctx.calls.map((c) => c.ref).sort(), ["li", "zhang"], "explicitly named twice → two answers");
  ctx.close();
});

test("3.4 meeting mode asks exactly one team for an inferred match", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "zhang", display: "张三" },
    { ref: "li", display: "李四" },
  ]);
  ctx.state.members = seeded.members;
  ctx.state.policy = { meetingMode: true };
  // Matches both teams' tags (their refs are the tags) and names nobody.
  ctx.state.utterance = "zhang 和 li 都看一下";

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "zhang 和 li 都看一下" });
  await waitFor(() => ctx.calls.length >= 1);
  await settle();
  assert.equal(ctx.calls.length, 1, "one meeting question, one answer");
  ctx.close();
});

test("3.3 a member with no team of their own is still dispatched by intent", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "zhang", display: "张三" },
    { ref: "li", display: "李四" },
  ]);
  ctx.state.members = seeded.members;
  // The speaker (some other member) owns nothing; 李四's team matches the topic.
  ctx.state.attribution = { certainty: "bound", memberId: "m-outsider" };
  ctx.state.utterance = "li 那个事怎么看";

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "li 那个事怎么看" });
  await waitFor(() => ctx.calls.length >= 1);
  await settle();
  assert.deepEqual(ctx.calls.map((c) => c.ref), ["li"], "a seatless speaker does not lose their message");
  const row = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.meta?.event === "route_decision");
  assert.equal(row.meta.kind, "intent");
  ctx.close();
});

// ── 4.1 the decision is a readable event ──────────────────────────────────

test("4.1 the decision lands as a shared event row with basis, reason and candidates", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [{ ref: "zhang", display: "张三" }]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "预算";
  ctx.state.attribution = { certainty: "session", memberId: seeded.members[0].id };

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "预算" });
  const row = await waitFor(() =>
    ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.meta?.event === "route_decision"),
  );
  assert.equal(row.kind, "event");
  assert.equal(row.visibility, "shared", "the room can read why it was routed");
  assert.equal(row.meta.kind, "attribution");
  assert.match(row.meta.reason, /归属/);
  assert.ok(Array.isArray(row.meta.candidates) && row.meta.candidates.length > 0, "candidates are recorded");
  assert.ok(Array.isArray(row.meta.recipients) && row.meta.recipients.length === 1);
  ctx.close();
});

// ── 4.3 cancellation before the tail starts ───────────────────────────────

test("4.3 cancelling mid-round stops the unstarted tail and bills nothing for it", async () => {
  // Every seat is slow, so whichever seat the store happens to hand the loop
  // first, the other two are still "not yet started" when the cancel arrives.
  const ctx = await boot({
    seam: standardSeam,
    agentScript: {
      one: { answer: "（一号的回答）", delayMs: 250 },
      two: { answer: "（二号的回答）", delayMs: 250 },
      three: { answer: "（三号的回答）", delayMs: 250 },
    },
  });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "one", display: "One" },
    { ref: "two", display: "Two" },
    { ref: "three", display: "Three" },
  ]);
  ctx.state.members = seeded.members;
  // Broadcast: no mention, no attribution, no matching tag → all three targets.
  ctx.state.utterance = "都看看";
  ctx.state.attribution = null;

  const posted = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "都看看" });
  const humanRow = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.kind === "human" && m.content === "都看看");
  const triggerSeq = humanRow?.seq ?? posted.body?.message?.seq;
  assert.ok(triggerSeq, "the human message has a seq to address");

  // Cancel while the first turn is still in flight.
  await new Promise((r) => setTimeout(r, 80));
  const cancelled = ctx.zhiyu.router.cancelDispatch({ roomId: seeded.roomId, triggerSeq, by: "a@x" });
  assert.equal(cancelled.ok, true);
  await settle();
  await settle();

  assert.equal(ctx.calls.length, 1, `only the turn already in flight ran, got ${ctx.calls.map((c) => c.ref).join(",")}`);
  assert.equal(ctx.usage.length, 1, "the unstarted tail was never billed");
  const rows = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {});
  const cancelRow = rows.find((m) => m.meta?.event === "route_cancelled");
  assert.ok(cancelRow, "the cancellation is a visible fact, not a silence");
  assert.equal(cancelRow.meta.skipped, 2);
  assert.equal(cancelRow.meta.answeredBeforeStop, 1);
  assert.equal(cancelRow.meta.skippedSeats.length, 2);
  ctx.close();
});

test("4.4 reassigning adds a new dispatch and leaves the original decision untouched", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "chent", display: "Chen" },
    { ref: "li", display: "Li" },
  ]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "chent 看一下";
  ctx.state.attribution = null;
  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "chent 看一下" });

  // Message rows carry no `id`; their identity inside a room is `seq`.
  const first = await waitFor(() =>
    ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.meta?.event === "route_decision"),
  );
  const firstSeq = first.seq;
  const firstSnapshot = JSON.stringify(first);
  assert.ok(firstSeq, "the decision row has a seq");
  await settle();

  const liSeat = seeded.members[1];
  const out = await ctx.zhiyu.router.reassignDispatch({
    room: ctx.zhiyu.store.roomGet(seeded.roomId),
    triggerSeq: firstSeq,
    targets: [liSeat.id],
    reason: "改派给李四",
    by: "a@x",
  });
  assert.equal(out.ok, true);
  await settle();

  const rows = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {});
  const after = rows.find((m) => m.seq === firstSeq);
  assert.equal(JSON.stringify(after), firstSnapshot, "the original decision is byte-identical");

  const reassigned = rows.find((m) => m.meta?.event === "route_reassigned");
  assert.ok(reassigned, "the reassignment is its own record, not a rewrite");
  assert.deepEqual(reassigned.meta.to, [liSeat.ref]);
  assert.match(reassigned.meta.reason, /改派/);
  assert.equal(reassigned.meta.by, "a@x");
  assert.ok(ctx.calls.some((c) => c.ref === "li"), "the new target was actually woken");
  ctx.close();
});

test("4.3 rebroadcasting the same utterance after a cancel is a fresh decision", async () => {
  // The cancel flag is per (room, trigger) — not per room. A later message must
  // dispatch normally, or one cancellation would mute the room forever.
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [{ ref: "one", display: "One" }]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "都看看";
  ctx.state.attribution = null;
  const first = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "都看看" });
  const seq1 = first.body?.message?.seq ?? ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.kind === "human")?.seq;
  ctx.zhiyu.router.cancelDispatch({ roomId: seeded.roomId, triggerSeq: seq1, by: "a@x" });
  await settle();
  const beforeSecond = ctx.calls.length;

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "都看看" });
  await waitFor(() => ctx.calls.length > beforeSecond);
  assert.equal(ctx.calls.length, beforeSecond + 1, "a new message dispatches normally");
  ctx.close();
});

// ── 6.1 the two entry points on the wire ─────────────────────────────────

test("6.1 the owner can stop or move a dispatch over HTTP; a plain member cannot", async () => {
  const ctx = await boot({
    seam: standardSeam,
    agentScript: { one: { answer: "（一号的回答）", delayMs: 200 }, two: { answer: "（二号的回答）", delayMs: 200 } },
  });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "one", display: "One" },
    { ref: "two", display: "Two" },
  ]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "都看看";
  ctx.state.attribution = null;

  const posted = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "都看看" });
  const humanSeq = posted.body?.message?.seq ?? ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.kind === "human")?.seq;
  assert.ok(humanSeq);

  // A stranger learns nothing — the room's existing posture (404, not 403).
  const stranger = await ctx.cli("b@x").post(`/api/zhiyu/rooms/${seeded.roomId}/dispatch/${humanSeq}/cancel`, {});
  assert.equal(stranger.status, 404, "a non-member must not learn the room exists");

  // An invited, accepted member IS a member — and still has no routing rights.
  const invited = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/invites`, { kind: "user", ref: "b@x" });
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  const inviteId = invited.body?.invite?.id;
  assert.ok(inviteId, "invite id is returned");
  const accepted = await ctx.cli("b@x").post(`/api/zhiyu/invites/${inviteId}/accept`, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  const member = await ctx.cli("b@x").post(`/api/zhiyu/rooms/${seeded.roomId}/dispatch/${humanSeq}/cancel`, {});
  assert.equal(member.status, 403, "a member who is neither owner nor the speaker cannot reroute");

  await new Promise((r) => setTimeout(r, 60));
  const cancelled = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/dispatch/${humanSeq}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.ok, true);
  await settle();
  await settle();
  assert.equal(ctx.calls.length, 1, `the tail was stopped, got ${ctx.calls.map((c) => c.ref).join(",")}`);
  assert.equal(ctx.usage.length, 1);
  ctx.close();
});

test("6.1 reassigning over HTTP wakes the new seat and records who moved it", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "one", display: "One" },
    { ref: "two", display: "Two" },
  ]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "one 看一下";
  ctx.state.attribution = null;
  const posted = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "one 看一下" });
  const humanSeq = posted.body?.message?.seq ?? ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.kind === "human")?.seq;
  await settle();

  const target = seeded.members[1];
  const moved = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/dispatch/${humanSeq}/reassign`, {
    targets: [target.id],
    reason: "改给二号",
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  await settle();

  const rows = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {});
  const reassigned = rows.find((m) => m.meta?.event === "route_reassigned");
  assert.ok(reassigned);
  assert.deepEqual(reassigned.meta.to, [target.ref]);
  assert.equal(reassigned.meta.by, "a@x");
  assert.ok(ctx.calls.some((c) => c.ref === "two"));

  // Bad input is refused with a code, not a crash.
  const noTargets = await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/dispatch/${humanSeq}/reassign`, {});
  assert.equal(noTargets.status, 400);
  ctx.close();
});

// ── 4.2 visibility follows the room's existing rules ──────────────────────

test("4.2 the decision row is a normal shared row: members see it, outsiders do not", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [{ ref: "zhang", display: "张三" }]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "预算";
  ctx.state.attribution = { certainty: "session", memberId: seeded.members[0].id };

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "预算" });
  await waitFor(() => ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {}).find((m) => m.meta?.event === "route_decision"));

  const asMember = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, { viewerMemberId: seeded.members[0].id });
  assert.ok(asMember.some((m) => m.meta?.event === "route_decision"), "a member reads the routing rationale");

  // A viewer id that belongs to no one in this room gets the visitor view, which
  // the store already restricts. The point of the assertion: the routing row
  // does not opt out of that filter by carrying an unusual visibility.
  const asOutsider = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, { viewerMemberId: "m-not-a-member" });
  const leaked = asOutsider.filter((m) => m.visibility !== "shared");
  assert.deepEqual(leaked, [], "no non-shared row is ever handed to an unknown viewer");
  ctx.close();
});

// ── 5.1 the answer cap is not bypassed by meeting mode ────────────────────

test("5.1 meeting mode cannot exceed the room's reply cap", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [
    { ref: "zhang", display: "张三" },
    { ref: "li", display: "李四" },
  ]);
  ctx.state.members = seeded.members;
  ctx.state.policy = { meetingMode: true };
  // Two explicit mentions under meeting mode: allowed two answers, but the room
  // cap is one, and the cap is the stronger rule.
  ctx.state.utterance = "@张三 @李四 都说说";
  await ctx.cli("a@x").patch(`/api/zhiyu/rooms/${seeded.roomId}`, { replyCap: 1 });

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "@张三 @李四 都说说" });
  const rows = await waitFor(() => {
    const r = ctx.zhiyu.store.messagesAfter(seeded.roomId, 0, {});
    return r.some((m) => m.meta?.event === "reply_cap_hit") ? r : null;
  });
  await settle();
  assert.equal(rows.filter((m) => m.kind === "agent").length, 1, "the cap still holds when routing widens the set");
  ctx.close();
});

// ── 5.3 billing is unchanged ──────────────────────────────────────────────

test("5.3 a voice-routed turn still settles one usage row", async () => {
  const ctx = await boot({ seam: standardSeam });
  const seeded = await seedRoom(ctx.cli, ctx.zhiyu, "a@x", [{ ref: "zhang", display: "张三" }]);
  ctx.state.members = seeded.members;
  ctx.state.utterance = "在吗";
  ctx.state.attribution = { certainty: "bound", memberId: seeded.members[0].id };

  await ctx.cli("a@x").post(`/api/zhiyu/rooms/${seeded.roomId}/messages`, { content: "在吗" });
  await waitFor(() => ctx.usage.length >= 1);
  assert.equal(ctx.usage.length, 1);
  assert.match(ctx.usage[0].usageId, /^zyr-/, "the same usage id shape as before — routing does not change billing");
  ctx.close();
});
