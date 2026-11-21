// Hermetic tests for the Chatwoot escalation helper (unify-im-solution C1.4).
// A fake fetchImpl asserts the exact request the live 4.19.0 accepted:
//   POST {base}/api/v1/accounts/{acc}/conversations/{conv}/toggle_status
//   Authorization: Bearer <token>, body {"status":"pending"}
import test from "node:test";
import assert from "node:assert/strict";
import { escalateToHuman } from "./escalate.js";

const bot = {
  type: "chatwoot",
  credentials: { baseUrl: "https://desk.example.com/", apiToken: "tok-123", accountId: "1" },
};

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = "{}" } = handler ? handler(url, init) : {};
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test("escalate: posts toggle_status pending with Bearer auth to the account-scoped URL", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 200, body: JSON.stringify({ id: 9, status: "pending" }) }));
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.deepEqual(r, { ok: true, status: "pending" });
  const c = fetchImpl.calls[0];
  assert.equal(c.url, "https://desk.example.com/api/v1/accounts/1/conversations/9/toggle_status");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.authorization, "Bearer tok-123");
  assert.deepEqual(JSON.parse(c.init.body), { status: "pending" });
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

test("escalate: 422 is reported as rejected", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 422, body: "bad" }));
  const r = await escalateToHuman(bot, "1:9", { fetchImpl });
  assert.equal(r.failure, "rejected");
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

test("escalate: a non-chatwoot bot is a programmer error (rejects)", async () => {
  await assert.rejects(() => escalateToHuman({ type: "slack", credentials: {} }, "1:9"), /not a chatwoot bot/);
});

test("escalate: missing credentials rejects", async () => {
  await assert.rejects(() => escalateToHuman({ type: "chatwoot", credentials: { baseUrl: "x" } }, "1:9"), /missing baseUrl/);
});
