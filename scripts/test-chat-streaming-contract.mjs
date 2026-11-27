#!/usr/bin/env node
// chat-streaming sub-contract unit guards (optimize-paas-module-audit N-15).
//
// The streaming lane is the hottest file in the repo (agent-session.js fix
// density 52%) but its regression net was all e2e. These drive the dsh→WS
// translation layer with a stub context — no child runtime, no LLM, no socket —
// and pin the three invariants the spec actually promises:
//   1. live text/reasoning deltas are broadcast as text/thinking events;
//   2. a streamed turn never re-emits the full text at settlement (exactly once);
//   3. a silent turn emits its settled text exactly once as fallback;
//   4. finishTurn is idempotent and always closes with one done.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppContext } from "../server/context.js";
import { attachDshEvents } from "../server/dsh-events.js";

const SESSION = "stream-unit-1";

function harness() {
  const ctx = createAppContext({});
  attachDshEvents(ctx);
  ctx.dshSessionId = SESSION;
  ctx.webTurnSessions = new Set([SESSION]);
  const sent = [];
  ctx.broadcast = (m) => sent.push(m);
  ctx.sendToViewers = (_sid, m) => sent.push(m);
  ctx.broadcastSessions = async () => {};
  const notify = (method, params) =>
    ctx.handleDshEvent({ method, params: { sessionId: SESSION, ...params } });
  const notifySessionEvent = (type, data) =>
    notify("session.event", { event: { type, seq: 1, time: 1, data } });
  return { ctx, sent, notify, notifySessionEvent };
}

function startSegment(notify) {
  notify("platform/stream", { frame: { type: "start" } });
}

function chunk(notify, chunk) {
  notify("platform/stream", { frame: { type: "chunk", chunk } });
}

function settle(notify, text) {
  notify("session.event", {
    event: {
      type: "assistant/message",
      seq: 2,
      time: 2,
      data: { message: { content: [{ type: "text", text }] } },
    },
  });
}

test("live text and reasoning deltas map to text/thinking events", () => {
  const { sent, notify } = harness();
  startSegment(notify);
  chunk(notify, { type: "text-delta", text: "你" });
  chunk(notify, { type: "text-delta", text: "好" });
  chunk(notify, { type: "reasoning-delta", text: "thinking aloud" });

  const texts = sent.filter((m) => m.type === "text").map((m) => m.delta);
  assert.deepEqual(texts, ["你", "好"]);
  const thinking = sent.filter((m) => m.type === "thinking").map((m) => m.delta);
  assert.deepEqual(thinking, ["thinking aloud"]);
});

test("streamed settlement is persisted without re-emitting the full text", () => {
  const { sent, notify } = harness();
  startSegment(notify);
  chunk(notify, { type: "text-delta", text: "hel" });
  chunk(notify, { type: "text-delta", text: "lo" });
  settle(notify, "hello");

  const texts = sent.filter((m) => m.type === "text").map((m) => m.delta);
  assert.deepEqual(texts, ["hel", "lo"], "no duplicate full-text delta at settlement");
});

test("silent turn emits settled text exactly once as fallback", () => {
  const { sent, notify } = harness();
  startSegment(notify);
  settle(notify, "hello");

  const texts = sent.filter((m) => m.type === "text").map((m) => m.delta);
  assert.deepEqual(texts, ["hello"]);
});

test("finishTurn closes once: idempotent even if idle fires twice", () => {
  const { ctx, sent } = harness();
  ctx.turnStateFor(SESSION).isStreaming = true;
  ctx.finishTurn("ok", SESSION);
  ctx.finishTurn("ok", SESSION);

  const dones = sent.filter((m) => m.type === "done");
  assert.equal(dones.length, 1, "done is not duplicated");
  assert.equal(ctx.turnStateFor(SESSION).isStreaming, false, "streaming flag reset");
});

test("reasoning leak filter strips a split <thinking> wall from deltas", () => {
  const { sent, notify } = harness();
  startSegment(notify);
  chunk(notify, { type: "text-delta", text: "<think" });
  chunk(notify, { type: "text-delta", text: "ing>secret</thinking>" });
  chunk(notify, { type: "text-delta", text: "visible" });

  const texts = sent.filter((m) => m.type === "text").map((m) => m.delta);
  assert.ok(!texts.join("").includes("secret"), "reasoning never reaches the viewer");
  assert.ok(texts.join("").includes("visible"), "post-tag text is kept");
});
