// Pins the fd-bot chatwoot adapter's parse against the payload Chatwoot 4.19.0
// actually sends, so the human-handoff guard cannot silently drift out of sync
// with the platform (chatwoot-ai-handoff task 1.3).
//
// The payload shape below is taken from the live box, not invented:
//   Message#webhook_data        → account/inbox/sender/conversation/message_type/private
//   Conversations::EventDataPresenter#webhook_data → status + meta.assignee_type
//   Conversation#assignee_type  → 'AgentBot' when ai_assignee is set, 'User' when
//                                 assignee_id is set (conversation.rb:224)
//
// The letter case is load-bearing and easy to get wrong: the conversation-level
// `meta.assignee_type` is 'User'/'AgentBot' (capitalized), while each entity's
// own `push_event_data.type` is 'user'/'agent_bot' (lowercase). The guard reads
// the former; a future refactor that switches to `meta.assignee.type` would
// compare 'User' against 'user' and never fire. This test fails in that case.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseCallback } from "../../fd-bot/src/adapters/chatwoot.js";

const SECRET = "pin-secret";
const credentials = { webhookSecret: SECRET };

function signed(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
  return { raw, headers: { "x-chatwoot-timestamp": ts, "x-chatwoot-signature": sig }, credentials };
}

// A first inbound message on a bot inbox — the exact case that was silenced.
function payload({ status = "pending", assigneeType = "AgentBot", assignee = null }) {
  return {
    event: "message_created",
    id: 4242,
    content: "你们这个数据服务怎么收费？",
    message_type: "incoming",
    private: false,
    account: { id: 1 },
    inbox: { id: 1 },
    sender: { id: 77, name: "访客 · A3F2" },
    conversation: {
      id: 9,
      status,
      meta: { assignee, assignee_type: assigneeType },
    },
  };
}

test("parse: a new bot conversation yields pending + an AgentBot assignee (capitalized)", () => {
  const { message } = parseCallback(signed(payload({ assignee: { id: 11, type: "agent_bot" } })));
  assert.ok(message, "a first message must parse to a message, not null");
  assert.equal(message.conversationStatus, "pending");
  assert.deepEqual(message.assignee, { id: 11, type: "AgentBot" }, "reads meta.assignee_type (capitalized), not meta.assignee.type");
  assert.equal(message.chatKey, "1:9");
});

test("parse: a human-assigned conversation yields assignee type 'User'", () => {
  const { message } = parseCallback(signed(payload({ status: "open", assigneeType: "User", assignee: { id: 5, type: "user" } })));
  assert.equal(message.assignee.type, "User");
  assert.equal(message.conversationStatus, "open");
});

test("parse: an unassigned conversation yields a null assignee (never fabricated)", () => {
  const { message } = parseCallback(signed(payload({ assigneeType: null, assignee: null })));
  assert.equal(message.assignee, null);
  assert.equal(message.conversationStatus, "pending");
});

test("parse: the guard's decision matches the platform's meaning on every state", () => {
  // Mirrors server/routes/bot-events.js: silent iff assignee.type === "User".
  const guard = (env) => (env.assignee?.type === "User" ? "silent" : "answer");
  const cases = [
    [{ status: "pending", assigneeType: "AgentBot", assignee: { id: 11, type: "agent_bot" } }, "answer"],
    [{ status: "pending", assigneeType: null, assignee: null }, "answer"],
    [{ status: "open", assigneeType: "User", assignee: { id: 5, type: "user" } }, "silent"],
    [{ status: "pending", assigneeType: "User", assignee: { id: 5, type: "user" } }, "silent"],
  ];
  for (const [p, want] of cases) {
    const { message } = parseCallback(signed(payload(p)));
    assert.equal(guard(message), want, `state ${JSON.stringify(p)} should be ${want}`);
  }
});