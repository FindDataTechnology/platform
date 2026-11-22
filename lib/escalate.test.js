// Hermetic tests for the Chatwoot escalation helper (chatwoot-ai-handoff).
// A fake fetchImpl asserts the exact request the live 4.19.0 accepts:
//   POST {base}/api/v1/accounts/{acc}/conversations/{conv}/assignments
//   Authorization: Bearer <token>, body {"assignee_id":N,"assignee_type":"User"}
//
// The point of these tests is the DECISION, not the transport: escalate must
// assign a human (moving the conversation out of the AI queue), never set a
// status. The old implementation set {"status":"pending"} — which on a bot
// inbox means "the AI is serving", i.e. it left the visitor in the queue no
// human can see. That regression is pinned by the first test.
import test from "node:test";
import assert from "node:assert/strict";
import { escalateToHuman } from "./escalate.js";

const bot = {
  type: "chatwoot",
  credentials: { baseUrl: "https://desk.example.com/", apiToken: "tok-123", accountId: "1", assigneeId: "5" },
};

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = JSON.stringify({ id: 5, name: "张三", role: "agent" }) } = handler ? handler(url, init) : {};
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test("escalate: assigns a HUMAN to the conversation (never sets a status)", async () => {
  const fetchImpl = fakeFetch();
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.deepEqual(r, { ok: true, status: "open", assigneeId: 5 });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, "https://desk.example.com/api/v1/accounts/1/conversations/9/assignments");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.authorization, "Bearer tok-123");
  assert.deepEqual(JSON.parse(c.init.body), { assignee_id: 5, assignee_type: "User" });
});

test("escalate: the old toggle_status/pending shape is gone (regression pin)", async () => {
  const fetchImpl = fakeFetch();
  await escalateToHuman(bot, "1:9", { fetchImpl });
  const c = fetchImpl.calls[0];
  assert.ok(!c.url.endsWith("/toggle_status"), "must not set status; pending on a bot inbox means the AI is serving");
  assert.notDeepEqual(JSON.parse(c.init.body), { status: "pending" });
});

test("escalate: trailing slash on baseUrl is trimmed (no double slash)", async () => {
  const fetchImpl = fakeFetch();
  await escalateToHuman({ ...bot, credentials: { ...bot.credentials, baseUrl: "https://d.example.com///" } }, "1:3", { fetchImpl });
  assert.ok(fetchImpl.calls[0].url.startsWith("https://d.example.com/api/v1/"));
});

test("escalate: 401 is reported as unauthorized, not a throw", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401, body: '{"errors":["nope"]}' }));
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.failure, "unauthorized");
});

test("escalate: 422 (target is not an agent) is target-unavailable, not a flat rejection", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 422, body: "bad" }));
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.equal(r.failure, "target-unavailable");
});

test("escalate: 500 is a flat rejection", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 500, body: "boom" }));
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.equal(r.failure, "rejected");
});

test("escalate: 200 with a null body means the id did not resolve → target-unavailable", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: "null" }));
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.failure, "target-unavailable");
});

test("escalate: transport failure is 'unreachable', not a throw", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.equal(r.failure, "unreachable");
});

test("escalate: a chatKey whose account disagrees with the credential is refused", async () => {
  const fetchImpl = fakeFetch();
  const r = await escalateToHuman(bot, "7:9", { fetchImpl });
  assert.equal(r.failure, "account-mismatch");
  assert.equal(fetchImpl.calls.length, 0);
});

test("escalate: missing conversation id in chatKey is refused", async () => {
  const fetchImpl = fakeFetch();
  const r = await escalateToHuman(bot, "1", { fetchImpl });
  assert.equal(r.failure, "bad-key");
});

test("escalate: a bot with no assigneeId is a config error, not a silent no-op", async () => {
  const noTarget = { ...bot, credentials: { baseUrl: "https://d.example.com", apiToken: "t", accountId: "1" } };
  await assert.rejects(() => escalateToHuman(noTarget, "1:9"), /no assigneeId configured/);
});

test("escalate: a non-chatwoot bot is a programmer error (rejects)", async () => {
  await assert.rejects(() => escalateToHuman({ type: "slack", credentials: {} }, "1:9"), /not a chatwoot bot/);
});

test("escalate: missing credentials rejects", async () => {
  await assert.rejects(() => escalateToHuman({ type: "chatwoot", credentials: { baseUrl: "x" } }, "1:9"), /missing baseUrl/);
});

test("escalate: a note/summary is written to custom_attributes BEFORE assigning", async () => {
  const fetchImpl = fakeFetch();
  const r = await escalateToHuman(bot, "1:9", {
    fetchImpl,
    reason: "cannot_answer",
    note: "问报价",
    summary: "访客问了数据服务收费，AI 无报价信息",
  });
  assert.equal(r.ok, true);
  // Two calls: the context write, then the assignment. Order matters — the
  // human must find the note already there when the assignment lands.
  assert.equal(fetchImpl.calls.length, 2);
  const [ctxCall, assignCall] = fetchImpl.calls;
  assert.match(ctxCall.url, /\/conversations\/9\/custom_attributes$/);
  const ctxBody = JSON.parse(ctxCall.init.body);
  assert.equal(ctxBody.custom_attributes.paas_handoff.reason, "cannot_answer");
  assert.equal(ctxBody.custom_attributes.paas_handoff.note, "问报价");
  assert.match(ctxBody.custom_attributes.paas_handoff.summary, /收费/);
  assert.match(assignCall.url, /\/assignments$/);
});

test("escalate: a failed context write never blocks the assignment", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/custom_attributes")) throw new Error("ECONNRESET");
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 5 }) };
  };
  const r = await escalateToHuman(bot, "1:9", { fetchImpl, note: "x" });
  assert.equal(r.ok, true, "the handoff must land even when the note cannot be written");
  assert.equal(calls.filter((u) => u.endsWith("/assignments")).length, 1);
});

test("escalate: no context given means no context write", async () => {
  const fetchImpl = fakeFetch();
  await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, "plain escalation must not invent a note");
});
