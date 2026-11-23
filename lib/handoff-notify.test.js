// Tests for the handoff notification (follow-up of chatwoot-ai-handoff).
//
// The properties that matter: it never guesses a destination, it never throws
// (a failed page must not undo a landed handoff), and the text carries no
// contact details beyond what the agent already wrote.
import test from "node:test";
import assert from "node:assert/strict";
import { notifyHandoff, renderAlert } from "./handoff-notify.js";

const botWith = (cred) => ({ type: "chatwoot", credentials: cred });

test("notify: no destination configured → sent:false, no send attempted", async () => {
  const calls = [];
  const send = async (...a) => calls.push(a);
  const r = await notifyHandoff(botWith({}), { chatKey: "1:9" }, { send });
  assert.equal(r.sent, false);
  assert.match(r.why, /no notification destination/);
  assert.equal(calls.length, 0, "must not page anyone by guessing");
});

test("notify: a configured destination receives the alert (by binding, cross-cell)", async () => {
  const calls = [];
  const send = async (args) => { calls.push(args); return { ok: true }; };
  const r = await notifyHandoff(
    botWith({ notifyBindingId: "bnd-1", notifyChatKey: "g1" }),
    { chatKey: "1:9", reason: "visitor_asked", note: "要人", summary: "访客要人工", assigneeId: 5 },
    { send },
  );
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bindingId, "bnd-1", "addresses fd-bot by binding, so it works across cells");
  assert.equal(calls[0].chatKey, "g1");
  assert.match(calls[0].text, /访客明确要求人工/);
});

test("notify: an fd-bot refusal verdict is a failed send, not a success", async () => {
  const send = async () => ({ ok: false, failure: "rejected", detail: "chatwoot 404" });
  const r = await notifyHandoff(botWith({ notifyBindingId: "b", notifyChatKey: "g" }), { chatKey: "1:9" }, { send });
  assert.equal(r.sent, false);
  assert.match(r.why, /chatwoot 404/);
});

test("notify: a failing channel is reported, never thrown (handoff already landed)", async () => {
  const send = async () => { throw new Error("fd-bot: channel unavailable"); };
  const r = await notifyHandoff(botWith({ notifyBindingId: "b1", notifyChatKey: "g1" }), { chatKey: "1:9" }, { send });
  assert.equal(r.sent, false);
  assert.match(r.why, /channel unavailable/);
});

test("render: maps the three reasons to human wording", () => {
  for (const [reason, word] of [
    ["cannot_answer", "回答不了"],
    ["visitor_asked", "要求人工"],
    ["beyond_authority", "授权范围"],
  ]) {
    assert.match(renderAlert({ reason }), new RegExp(word));
  }
});

test("render: an unknown/absent reason never crashes and says so", () => {
  assert.match(renderAlert({}), /未注明原因/);
  assert.match(renderAlert({ reason: "weird" }), /weird/);
});

test("render: long text is capped, not truncated silently into a wall", () => {
  const r = renderAlert({ summary: "x".repeat(5000) });
  assert.ok(r.length < 1200, `alert must stay bounded, got ${r.length}`);
});

test("render: carries the opaque chatKey so the agent can find the conversation", () => {
  assert.match(renderAlert({ chatKey: "1:42" }), /1:42/);
});