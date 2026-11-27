// wecom-webhook adapter contract (make-im-lane-outbound-capable 2.1-2.3).
// Run: node --test scripts/test-wecom-webhook-adapter.mjs
//
// This adapter exists for ONE property: it delivers from any egress. Its risks
// are the mirror image — it can be pointed at an arbitrary URL (exfiltration) and
// its key is a password living in a URL. Both are asserted here.

import test from "node:test";
import assert from "node:assert/strict";

import { registry, isValidWebhookUrl, webhookFingerprint } from "../server/bots/wecom-webhook.js";
import { outboundCapabilityFor, isOutboundOnly, validateCredentials, BOT_TYPES } from "../server/bots/adapter.js";

const GOOD = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd-efgh";

test("the webhook URL shape is a credential boundary, not a formality", () => {
  assert.ok(isValidWebhookUrl(GOOD));
  // Anything that could carry room content elsewhere is refused.
  for (const bad of [
    "https://evil.example/cgi-bin/webhook/send?key=12345678-abcd",
    "http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd", // not https
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send", // no key
    "https://qyapi.weixin.qq.com/cgi-bin/message/send?key=12345678-abcd", // wrong API
    "https://qyapi.weixin.qq.com.evil.example/cgi-bin/webhook/send?key=1234-abcd",
    "",
    null,
  ]) {
    assert.ok(!isValidWebhookUrl(bad), `must refuse: ${bad}`);
  }
});

test("the fingerprint never reveals the key", () => {
  const fp = webhookFingerprint(GOOD);
  assert.equal(fp, "…efgh");
  assert.ok(!fp.includes("12345678"), "the leading part of the key must not appear");
});

test("save-time validation refuses a present-but-unusable URL", () => {
  // The worse failure is a credential that SAVES and only fails at send time.
  assert.equal(validateCredentials("wecom-webhook", { groupWebhookUrl: GOOD }), null);
  const bad = validateCredentials("wecom-webhook", { groupWebhookUrl: "https://example.com/x" });
  assert.ok(bad && /Webhook/.test(bad), `expected a shape complaint, got: ${bad}`);
  const missing = validateCredentials("wecom-webhook", {});
  assert.ok(missing && /Missing credentials/.test(missing));
});

test("it is declared outbound-only, and that is enforced by capability", () => {
  assert.ok(BOT_TYPES.includes("wecom-webhook"), "registered as a bot type");
  const cap = outboundCapabilityFor("wecom-webhook");
  assert.equal(cap.mode, "url-keyed", "no caller-IP allowlist: this is the whole point");
  assert.equal(cap.inbound, false, "a group robot has no callback");
  assert.equal(isOutboundOnly("wecom-webhook"), true);
  assert.equal(isOutboundOnly("wecom-bot"), false, "the intelligent robot does receive");
});

test("inbound entry points throw rather than pretend", async () => {
  // Reaching these means routing is wrong; a benign null would hide it.
  await assert.rejects(() => registry.verifyWebhook(), /no inbound path/);
  await assert.rejects(() => registry.parseMessage(), /no inbound path/);
});

test("sendText posts the markdown the robot consumes, and surfaces platform errors", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
  };
  await registry.sendText({ groupWebhookUrl: GOOD }, "any-chat", "**结论**：按季度聚合");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOD, "the URL names the group — chatKey is not used");
  assert.deepEqual(calls[0].body, { msgtype: "markdown", markdown: { content: "**结论**：按季度聚合" } });

  // Rate limit and dead key must be distinguishable by their code, verbatim.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ errcode: 45009, errmsg: "api freq out of limit" }), { status: 200 });
  await assert.rejects(() => registry.sendText({ groupWebhookUrl: GOOD }, "c", "x"), /45009/);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook url" }), { status: 200 });
  await assert.rejects(() => registry.sendText({ groupWebhookUrl: GOOD }, "c", "x"), /93000/);

  // An invalid stored URL fails loudly instead of posting somewhere arbitrary.
  await assert.rejects(() => registry.sendText({ groupWebhookUrl: "https://x.example/y" }, "c", "t"), /not a valid/);
  globalThis.fetch = originalFetch;
});

test("the bot projection never carries the group webhook URL (2.3)", async () => {
  const { maskBot } = await import("../server/bots.js");
  const masked = maskBot({
    id: "b1",
    type: "wecom-webhook",
    name: "群发",
    enabled: true,
    secret: "path-secret",
    credentials: { groupWebhookUrl: GOOD },
  });
  const serialized = JSON.stringify(masked);
  assert.ok(!serialized.includes("12345678-abcd-efgh"), "the key must never leave the server");
  assert.ok(!serialized.includes(GOOD), "the whole URL must never leave the server");
  // What DOES leave: the fact that it is configured, plus the bot's own inbound
  // callback URL (a different thing that happens to be called webhookUrl).
  assert.deepEqual(masked.configuredCredentials, ["groupWebhookUrl"]);
  assert.ok(String(masked.webhookUrl).includes("/api/bots/webhook/b1/"), "that field is OUR callback, not theirs");
});

test("an inbound request to an outbound-only bot is refused, not crashed (2.2)", async () => {
  // The route consults the adapter's declaration; verifyWebhook would throw, and
  // a 500 with a stack is a worse answer than the same 403 an unknown bot gets.
  const express = (await import("express")).default;
  const { registerBotRoutes } = await import("../server/routes/bots.js");
  const botRow = {
    id: "wh1",
    type: "wecom-webhook",
    name: "群发",
    enabled: true,
    secret: "s3cret",
    credentials: { groupWebhookUrl: GOOD },
  };
  const app = express();
  registerBotRoutes({
    app,
    db: { getBot: (id) => (id === botRow.id ? botRow : null), listBots: () => [botRow], isDbReady: () => true },
    requireAdmin: () => true,
    authEnabled: false,
    user: undefined,
  });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${base}/api/bots/webhook/wh1/s3cret`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(res.status, 403, "outbound-only bots have no inbound path");
  srv.close();
});
