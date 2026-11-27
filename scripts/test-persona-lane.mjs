#!/usr/bin/env node
// ── The persona seat lane ───────────────────────────────────────────────────
//
// A persona/auditor post runs on its owner's own cell: no deployment row, no
// registry a2a endpoint, nothing for sale. It answers through the cell's
// synchronous turn endpoint (server/routes/gateway-turn.js).
//
// What this file pins:
//   · the ref shape is owned by this lane and no other (`persona:` prefix);
//   · the request carries the owner's identity and the gateway secret — the
//     cell re-checks ownership, so the header is a claim, not proof;
//   · failures are distinguishable — unreachable seat vs the post refusing —
//     because the room shows them differently;
//   · settlement is honestly "the cell metered it", not an invented zero.
//
// Run: node --test scripts/test-persona-lane.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { createZhiyuPersonaLane } from "../gateway/zhiyu/persona-lane.js";

const OWNER = "owner@test";
const CELL = { base: "http://cell.local", email: OWNER, secret: "s3cret" };

/** A fetch stand-in that records the request and answers `reply`. */
function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = await reply(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const seat = (ref = `persona:fleet_1:m_1`, onBehalfOf = OWNER) => ({ ref, title: "幕僚长", onBehalfOf });

test("the lane owns exactly the persona: refs", () => {
  const lane = createZhiyuPersonaLane({ cellFor: () => CELL, fetchImpl: fakeFetch(async () => ({ status: 200, body: {} })) });
  assert.equal(lane.handles("persona:fleet_1:m_1"), true);
  assert.equal(lane.handles("p1:mp"), false, "a market deployment ref belongs to the other lane");
  assert.equal(lane.handles("persona:fleet_1"), false, "two parts is not a seat");
  assert.equal(lane.handles("persona::m_1"), false, "an empty fleet id is not a seat");
  assert.equal(lane.handles(null), false);
  assert.deepEqual(lane.parseRef("persona:fleet_1:m_1"), { fleetId: "fleet_1", memberId: "m_1" });
});

test("a turn posts to the owner's cell with identity and secret", async () => {
  const f = fakeFetch(async () => ({ status: 200, body: { ok: true, text: "今天三件事。" } }));
  const lane = createZhiyuPersonaLane({ cellFor: () => CELL, fetchImpl: f });
  const out = await lane.callAgent(seat(), { text: "报一下进度", contextId: "ctx-1" });

  assert.deepEqual(out, { text: "今天三件事。" }, "same shape the agent lane returns, so the room turn loop stays lane-agnostic");
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, "http://cell.local/api/gateway/sync-turn");
  assert.equal(init.headers["x-forwarded-email"], OWNER, "the claim the cell re-checks");
  assert.equal(init.headers["x-cloud-gateway-secret"], "s3cret");
  assert.deepEqual(
    { fleetId: body.fleetId, memberId: body.memberId, text: body.text, contextId: body.contextId },
    { fleetId: "fleet_1", memberId: "m_1", text: "报一下进度", contextId: "ctx-1" },
  );
});

test("a parked owner (no cell) is an unreachable seat, said plainly", async () => {
  const lane = createZhiyuPersonaLane({ cellFor: () => null, fetchImpl: fakeFetch(async () => ({ status: 200, body: {} })) });
  await assert.rejects(() => lane.callAgent(seat(), { text: "hi" }), /no running cell/);
});

test("the post refusing and the seat being unreachable are different failures", async () => {
  const refusing = createZhiyuPersonaLane({
    cellFor: () => CELL,
    fetchImpl: fakeFetch(async () => ({ status: 200, body: { ok: false, code: "turn_failed", error: "model said no" } })),
  });
  const err1 = await refusing.callAgent(seat(), { text: "hi" }).catch((e) => e);
  assert.equal(err1.code, "turn_failed", "a refusal carries the cell's own code");
  assert.match(err1.message, /model said no/);

  const dead = createZhiyuPersonaLane({
    cellFor: () => CELL,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  const err2 = await dead.callAgent(seat(), { text: "hi" }).catch((e) => e);
  assert.equal(err2.code, "SEAT_UNREACHABLE", "a transport failure is not a refusal — the room must be able to say which");
});

test("a 503 from the cell is surfaced with its code, not swallowed as empty text", async () => {
  const lane = createZhiyuPersonaLane({
    cellFor: () => CELL,
    fetchImpl: fakeFetch(async () => ({ status: 503, body: { ok: false, code: "runtime_not_ready", error: "not ready" } })),
  });
  const err = await lane.callAgent(seat(), { text: "hi" }).catch((e) => e);
  assert.equal(err.status, 503);
  assert.equal(err.code, "runtime_not_ready");
});

test("settlement says the cell metered it instead of inventing a zero", async () => {
  const lane = createZhiyuPersonaLane({ cellFor: () => CELL, fetchImpl: fakeFetch(async () => ({ status: 200, body: {} })) });
  assert.deepEqual(await lane.settleTurn(), { settled: false, reason: "cell-metered" },
    "the gateway did not bill this turn; claiming otherwise would double-count");
});

test("an async cellFor is awaited (the cell wakes on demand)", async () => {
  const f = fakeFetch(async () => ({ status: 200, body: { ok: true, text: "醒了" } }));
  const lane = createZhiyuPersonaLane({ cellFor: async () => CELL, fetchImpl: f });
  assert.deepEqual(await lane.callAgent(seat(), { text: "hi" }), { text: "醒了" });
});
