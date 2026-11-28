// Room commander contract (add-room-commander 1.1 / 1.2).
// Run: node --test scripts/test-zhiyu-commander.mjs
//
// The commander exists because a round with no owner can legally produce nothing
// (2026-11-19: 44s of dead air in a customer group). These tests pin the two
// properties that make it safe: a decision is STRUCTURED or it is null, and one
// invented seat never costs the whole round.

import test from "node:test";
import assert from "node:assert/strict";

import { parseDecision, createCommander, buildCommanderPrompt, COMMANDER_INTENTS } from "../gateway/zhiyu/commander.js";

const SEATS = [
  { id: "mem_a", display: "产品顾问", ref: "pack:advisor", kind: "agent", state: "active" },
  { id: "mem_b", display: "项目评估师", ref: "pack:assessor", kind: "agent", state: "active" },
];

test("a well-formed decision survives parsing", () => {
  const d = parseDecision(
    { intent: "task", dispatch: [{ seatId: "mem_a", points: "看本周产品线进展" }], selfAnswer: false, receipt: true, noOneReason: null },
    { seats: SEATS },
  );
  assert.equal(d.intent, "task");
  assert.deepEqual(d.dispatch, [{ seatId: "mem_a", points: "看本周产品线进展" }]);
  assert.equal(d.receipt, true);
});

test("fenced JSON is the actual contract, not leniency", () => {
  // Models fence JSON routinely; failing on it would degrade every other turn.
  const d = parseDecision('```json\n{"intent":"meta","selfAnswer":true}\n```', { seats: SEATS });
  assert.equal(d.selfAnswer, true);
  assert.equal(d.intent, "meta");
});

test("prose is not a decision — it is null, and the caller degrades", () => {
  // The failure mode this whole module exists to prevent: a model that talks a
  // great deal and decides nothing.
  assert.equal(parseDecision("我觉得应该让产品顾问来回答这个问题", { seats: SEATS }), null);
  assert.equal(parseDecision("", { seats: SEATS }), null);
  assert.equal(parseDecision(null, { seats: SEATS }), null);
  assert.equal(parseDecision("{not json", { seats: SEATS }), null);
});

test("deciding nothing is null, not a silent broadcast", () => {
  assert.equal(parseDecision({ intent: "task" }, { seats: SEATS }), null);
  assert.equal(parseDecision({ intent: "task", dispatch: [], selfAnswer: false }, { seats: SEATS }), null);
});

test("an invented seat is dropped, not fatal", () => {
  const d = parseDecision(
    { intent: "task", dispatch: [{ seatId: "mem_ghost", points: "x" }, { seatId: "mem_a", points: "y" }] },
    { seats: SEATS },
  );
  assert.equal(d.dispatch.length, 1, "the real seat still gets its dispatch");
  assert.equal(d.dispatch[0].seatId, "mem_a");
  assert.equal(d.hallucinated, 1, "and the invention is counted so it can be logged");
});

test("self-answering AND dispatching is not a decision", () => {
  // Mutually exclusive by construction; both set means the model ducked the call.
  assert.equal(
    parseDecision({ intent: "task", selfAnswer: true, dispatch: [{ seatId: "mem_a", points: "x" }] }, { seats: SEATS }),
    null,
  );
});

test("an unrecognised intent degrades to 'unclear' rather than throwing", () => {
  const d = parseDecision({ intent: "interpretive-dance", selfAnswer: true }, { seats: SEATS });
  assert.equal(d.intent, "unclear");
  assert.ok(COMMANDER_INTENTS.includes(d.intent));
});

test("the prompt names every seat with the id the decision must use", () => {
  const p = buildCommanderPrompt({
    room: { id: "zy_1", title: "幕僚团" },
    sender: { display: "老板", ref: "boss@x" },
    message: { content: "本周产品线进展" },
    seats: SEATS,
  });
  assert.ok(p.includes("id=mem_a"), "seat ids must be visible or the model cannot name them");
  assert.ok(p.includes("本周产品线进展"), "the message rides the prompt");
  assert.ok(p.includes("selfAnswer=true"), "the self-answer rule is stated");
});

test("the commander yields a decision for an ordinary message (no more broadcast default)", async () => {
  const route = createCommander({
    enabled: () => true,
    callCommander: async () => JSON.stringify({ intent: "task", dispatch: [{ seatId: "mem_a", points: "查进展" }] }),
  });
  const out = await route({ room: { id: "zy_1" }, member: { ref: "boss@x", display: "老板" }, message: { content: "本周产品线进展" }, agents: SEATS });
  assert.equal(out.basis, "commander");
  assert.equal(out.recipients.length, 1);
  assert.equal(out.recipients[0].id, "mem_a");
  assert.equal(out.receipt, true, "a dispatch is always preceded by a receipt");
});

test("greeting goes to the commander itself instead of waking seats", async () => {
  const route = createCommander({
    enabled: () => true,
    callCommander: async () => JSON.stringify({ intent: "greeting", selfAnswer: true }),
  });
  const out = await route({ room: { id: "zy_1" }, member: { ref: "g@x" }, message: { content: "你好" }, agents: SEATS });
  assert.equal(out.selfAnswer, true);
  assert.equal(out.recipients.length, 0, "no seat should be woken for a greeting");
});

test("nobody suitable carries a reason, so the group is never left guessing", async () => {
  const route = createCommander({
    enabled: () => true,
    callCommander: async () => JSON.stringify({ intent: "task", dispatch: [], noOneReason: "这个问题需要数据权限，请联系管理员" }),
  });
  const out = await route({ room: { id: "zy_1" }, member: { ref: "g@x" }, message: { content: "内部财务数据" }, agents: SEATS });
  assert.equal(out.basis, "commander_none");
  assert.equal(out.reason, "这个问题需要数据权限，请联系管理员");
});

test("a commander failure is null, so the router keeps today's behaviour", async () => {
  const route = createCommander({ enabled: () => true, callCommander: async () => { throw new Error("model down"); }, log: { warn() {} } });
  const out = await route({ room: { id: "zy_1" }, member: { ref: "g@x" }, message: { content: "x" }, agents: SEATS });
  assert.equal(out, null, "null = not my policy → the router broadcasts and records a degradation");
});

test("a slow commander times out instead of hanging the round", async () => {
  const route = createCommander({
    enabled: () => true,
    timeoutMs: 30,
    callCommander: () => new Promise((r) => setTimeout(() => r(JSON.stringify({ selfAnswer: true })), 5000)),
    log: { warn() {} },
  });
  const started = Date.now();
  const out = await route({ room: { id: "zy_1" }, member: { ref: "g@x" }, message: { content: "x" }, agents: SEATS });
  assert.equal(out, null);
  assert.ok(Date.now() - started < 1000, "the round must not wait for a stuck commander");
});

test("switch off = the seam is not supplied, byte-identical to before", async () => {
  const route = createCommander({ enabled: () => false, callCommander: async () => JSON.stringify({ selfAnswer: true }) });
  const out = await route({ room: { id: "zy_1" }, member: { ref: "g@x" }, message: { content: "x" }, agents: SEATS });
  assert.equal(out, null);
});

// ── End-to-end through the real router ───────────────────────────────────────
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function boot({ commanderOn }) {
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-cmd-"));
  const calls = []; // { ref, text }
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    env: { ...process.env, ZHIYU_ROOM_COMMANDER: commanderOn ? "1" : "" },
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "auth" }),
    callAgent: async (member, { text, contextId }) => {
      calls.push({ ref: member.ref, text, contextId });
      // The commander borrows a real seat's deployment (an invented ref has no
      // deployment behind it — production taught us that on the first live turn),
      // so it is recognised by its contextId, not by its ref.
      if (String(contextId ?? "").startsWith("room-commander:")) {
        // The commander sees the roster and picks the first seat for a task,
        // answers greetings itself, and declines when told nobody fits.
        // Match the USER'S line only — the prompt template itself contains the
        // word `selfAnswer` (it is a rule), so matching the whole prompt would
        // classify every message as a greeting. That bug was in this fixture, and
        // it is worth the comment: the same trap is waiting for any real
        // implementation that scans its own prompt.
        const userLine = text.slice(text.lastIndexOf("说："));
        if (/你好|寒暄/.test(userLine)) return { text: JSON.stringify({ intent: "greeting", selfAnswer: true }) };
        const id = /id=(mem_[a-z0-9]+)/.exec(text)?.[1];
        return { text: JSON.stringify({ intent: "task", dispatch: id ? [{ seatId: id, points: "处理它" }] : [] }) };
      }
      return { text: `${member.display}的实质回答` };
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
    return r.json();
  };
  return { zhiyu, calls, j, close: () => srv.close() };
}

// Seats are added through the store (the same way the router tests do it): an
// INVITE is not a seat — it is an offer, and an unanswered offer leaves the room
// empty, which is a different scenario from the one under test.
async function seedRoom(j, zhiyu, refs) {
  const room = await j("POST", "/api/zhiyu/rooms", { title: "t" });
  const roomId = room.room?.id ?? room.id;
  for (const ref of refs) zhiyu.store.memberAdd({ roomId, kind: "agent", ref, display: ref });
  return roomId;
}

test("with the commander on, a task message reaches exactly the seat it chose", async () => {
  const { zhiyu, calls, j, close } = await boot({ commanderOn: true });
  const roomId = await seedRoom(j, zhiyu, ["advisor", "assessor"]);
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "本周产品线进展" });
  await new Promise((r) => setTimeout(r, 600));

  const seatCalls = calls.filter((c) => !String(c.contextId ?? "").startsWith("room-commander:"));
  assert.equal(seatCalls.length, 1, "one dispatch, one seat woken — not a broadcast");

  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.equal(rows.filter((r) => r.meta?.event === "commander_decision").length, 0, "a dispatch is not a self-answer");
  const receipt = rows.find((r) => r.meta?.event === "commander_receipt");
  assert.ok(receipt, "the group gets a receipt before the seat finishes");
  const agentRow = rows.find((r) => r.kind === "agent");
  assert.ok(agentRow, "and then the answer");
  assert.ok(receipt.createdAt <= agentRow.createdAt, "receipt first, answer second");
  close();
});

test("with the commander on, a greeting is answered by the commander, not by waking seats", async () => {
  const { zhiyu, calls, j, close } = await boot({ commanderOn: true });
  const roomId = await seedRoom(j, zhiyu, ["advisor", "assessor"]);
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "你好" });
  await new Promise((r) => setTimeout(r, 600));

  // The commander runs ON a seat's deployment, so exactly one model call happens
  // (the commander's own). What must NOT happen is a SEAT TURN — no agent row
  // attributed to a seat, and no all-passed round.
  const seatTurns = calls.filter((c) => !String(c.contextId ?? "").startsWith("room-commander:"));
  assert.equal(seatTurns.length, 0, "no seat gets a turn of its own on a greeting");
  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.ok(!rows.some((r) => r.meta?.event === "all_passed"), "and the round never reaches all-passed");
  const answered = rows.find((r) => r.kind === "agent");
  assert.ok(answered, "the commander answered the greeting itself");
  assert.equal(answered.meta?.mode, "commander", "and the row says so");
  close();
});

test("with the commander OFF, behaviour is the legacy broadcast (no receipt, no decision)", async () => {
  const { zhiyu, j, close } = await boot({ commanderOn: false });
  const roomId = await seedRoom(j, zhiyu, ["advisor", "assessor"]);
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "本周产品线进展" });
  await new Promise((r) => setTimeout(r, 600));
  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.ok(!rows.some((r) => r.meta?.event === "commander_receipt"), "no receipt without the switch");
  assert.ok(!rows.some((r) => r.meta?.event === "commander_decision"), "no decision without the switch");
  close();
});

test("the receipt fires BEFORE the model answers, not after (2026-11-19)", async () => {
  // The whole point of the receipt is to fill the wait. A version that emitted it
  // after the decision would pass a "receipt exists" test and still leave the
  // group staring at silence — which is the bug we were fixing.
  const order = [];
  const route = createCommander({
    enabled: () => true,
    onThinking: () => order.push("receipt"),
    callCommander: async () => {
      order.push("model");
      return JSON.stringify({ intent: "task", dispatch: [{ seatId: "mem_a", points: "x" }] });
    },
  });
  await route({ room: { id: "zy_1" }, member: { ref: "g@x" }, message: { content: "本周进展" }, agents: SEATS });
  assert.deepEqual(order, ["receipt", "model"], "receipt first, model second");
});

test("a failing thinking marker does not stop the decision", async () => {
  const route = createCommander({
    enabled: () => true,
    log: { warn() {} },
    onThinking: () => { throw new Error("store down"); },
    callCommander: async () => JSON.stringify({ intent: "task", dispatch: [{ seatId: "mem_a", points: "x" }] }),
  });
  const out = await route({ room: { id: "zy_1" }, member: { ref: "g@x" }, message: { content: "x" }, agents: SEATS });
  assert.equal(out.basis, "commander", "the round still routes");
});
