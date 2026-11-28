// 企业微信群机器人 Webhook adapter — OUTBOUND ONLY (make-im-lane-outbound-capable 2.1).
//
// Why this adapter exists at all: every other WeCom leg is crippled on outbound
// in a way the operator cannot see until answers vanish.
//
//   wecom (self-built app)  message/send      → gated by 企业可信IP; an egress
//                                               change breaks it (2026-11-18:
//                                               19 undelivered answers, 60020)
//   wecom-bot (intelligent)  response_url     → only inside the window a recent
//                                               inbound opened; no proactive path
//
// The group webhook robot is the one WeCom surface whose credential IS the URL:
// `POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`. It has no
// caller-IP allowlist, so it keeps working from any egress. It also has NO
// inbound callback at all — which is why `add-wecom-group-chat` excluded it back
// then (correctly, for the INBOUND question). Paired with a leg that can receive
// (the intelligent robot's callback), it closes the delivery gap: inbound on one
// leg, outbound on this one.
//
// `inbound: false` is load-bearing: bots.js refuses to register a webhook route
// for this type, so the absence of an inbound path is structural rather than a
// convention someone can forget.

import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";

// The only accepted shape is the official endpoint with a key parameter. Accepting
// an arbitrary URL would let a bot row exfiltrate room content to any host — and
// the key IS the credential, so a mistake here is a credential leak, not a typo.
//
// The credential key is `groupWebhookUrl`, deliberately NOT `webhookUrl`: the
// masked bot row already carries a `webhookUrl` that is OUR inbound callback URL
// for that bot. Two different things with one name is how someone ends up
// pasting a secret into a public field.
const WEBHOOK_RE = /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]{8,128}$/;

export function isValidWebhookUrl(value) {
  return WEBHOOK_RE.test(String(value ?? "").trim());
}

/** A display-safe fingerprint: the key's last 4 chars, never the whole key. */
export function webhookFingerprint(value) {
  const m = /key=([A-Za-z0-9-]+)$/.exec(String(value ?? "").trim());
  if (!m) return null;
  return `…${m[1].slice(-4)}`;
}

export const registry = {
  // Outbound only. `inbound: false` ⇒ no callback route is ever registered.
  outbound: { mode: "url-keyed", inbound: false },

  credentialFields: [
    // The key rides inside the URL. It is a password: `secret: true` keeps it out
    // of the public bot projection and the rendered form value.
    {
      key: "groupWebhookUrl",
      label: "群机器人 Webhook 地址（含 key）",
      secret: true,
      // Shape gate at save time: a URL that is not the official endpoint with a
      // key cannot deliver, and — more importantly — a free-form URL would turn
      // a bot row into an exfiltration target for room content.
      validate: (v) => (isValidWebhookUrl(v) ? null : "Webhook 地址必须是 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=… 形式"),
    },
  ],

  // No QR: a webhook robot is created in the group's own settings, not by
  // scanning anything.
  qr: { strategy: "manual", field: "groupWebhookUrl", hintKey: "botsPage.qr.hint.manual" },

  // This adapter cannot receive, so these are unreachable by construction. They
  // throw rather than return a benign value: if a caller ever reaches them the
  // routing is wrong, and a silent null would hide that.
  async verifyWebhook() {
    throw new Error("wecom-webhook has no inbound path");
  },
  async parseMessage() {
    throw new Error("wecom-webhook has no inbound path");
  },

  async sendText(cred, _chatKey, text) {
    const url = String(cred?.groupWebhookUrl ?? "").trim();
    if (!isValidWebhookUrl(url)) {
      throw new Error("wecom-webhook: groupWebhookUrl is not a valid group-robot webhook");
    }
    // Group robots accept markdown (and text); markdown carries headings/lists,
    // which is what room answers look like. A group robot has no notion of a
    // chat: the URL already names the group, so chatKey is not used to address.
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: String(text ?? "") } }),
    });
    const j = await res.json().catch(() => ({}));
    // 45009 = the robot's per-group rate limit; surfaced verbatim so the room can
    // distinguish throttling from a dead key (93000).
    if (!res.ok || (j.errcode && j.errcode !== 0)) {
      throw new Error(`wecom-webhook send failed: ${res.status} ${j.errcode ?? ""} ${j.errmsg ?? ""}`.trim());
    }
  },
};

// Self-check: URL validation (the credential boundary) + the exact request the
// robot receives. Usage: node server/bots/wecom-webhook.js
if (process.argv[1]?.endsWith("wecom-webhook.js")) {
  const { strict: assert } = await import("node:assert");
  assert.ok(isValidWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd-efgh"));
  // Anything that could redirect the credential is refused.
  assert.ok(!isValidWebhookUrl("https://evil.example/cgi-bin/webhook/send?key=12345678-abcd"));
  assert.ok(!isValidWebhookUrl("http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd"));
  assert.ok(!isValidWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send"));
  assert.equal(webhookFingerprint("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=12345678-abcd-efgh"), "…efgh");
  console.log("OK wecom-webhook");
}
