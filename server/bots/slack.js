// Slack adapter (Events API, HTTP webhook mode).
//
// Three platform facts shape this file:
//
// 1. Slack signs every request: `X-Slack-Signature` = "v0=" + HMAC-SHA256(
//    signing_secret, "v0:{X-Slack-Request-Timestamp}:{raw body}") in hex. The
//    raw bytes MUST be the ones Slack sent — our webhook route captures them
//    (express.raw) before any JSON parse, so `req.raw` is exact.
// 2. The timestamp is checked against a 5-minute window; outside it the
//    request is a replay and is refused (docs: "verifying requests from Slack").
// 3. `url_verification` arrives on the same endpoint as real events and wants
//    its challenge echoed — JSON, plaintext and form-encoded are all accepted;
//    we answer JSON like the feishu adapter does.
//
// chatKey carries the THREAD when there is one (`C123:1673464730.703009`) and
// the bare channel otherwise. A Slack thread is where a group actually talks
// about one thing, so it is the right room boundary; channel-level messages
// (no thread) fall back to the channel. Colon never appears in a Slack channel
// id or a ts, so the first colon is an unambiguous split.
//
// Docs: https://docs.slack.dev/authentication/verifying-requests-from-slack/
//       https://docs.slack.dev/reference/events/message/

import crypto from "node:crypto";
import { postJson } from "./adapter.js";

const API = "https://slack.com/api";
const MAX_SKEW_SEC = 5 * 60;

// The ONE subtype that carries a real person's text we want.
// Everything else (message_changed/deleted/join/leave/bot_message/...) is
// noise: edits would double-post into the room, bot echoes would loop.
// `file_share` is deliberately absent — Slack stopped dispatching that subtype
// (file shares now arrive as a plain `message` carrying a `files` array), so
// listing it would be dead code pretending to handle a case it can't see.
const KEPT_SUBTYPES = new Set(["thread_broadcast"]);

/** channel[:thread_ts] → the two platform fields chat.postMessage needs. */
export function splitChatKey(chatKey) {
  const s = String(chatKey ?? "");
  const i = s.indexOf(":");
  return i === -1 ? { channel: s, threadTs: null } : { channel: s.slice(0, i), threadTs: s.slice(i + 1) || null };
}

function checkSignature(req, cred) {
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) throw new Error("missing signature headers");
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_SEC) throw new Error("stale request timestamp");
  const expected = `v0=${crypto.createHmac("sha256", cred.signingSecret).update(`v0:${ts}:${req.raw}`).digest("hex")}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad signature");
}

export const registry = {
  // Outbound capability (make-im-lane-outbound-capable): the bot token rides
  // an `Authorization: Bearer` header and Slack applies no caller-IP allowlist,
  // so this leg keeps delivering when our egress address changes — the exact
  // failure mode that broke the WeCom self-built app in production on 11-18.
  // Declared here, next to the sending code, because an undeclared platform
  // answers "none" and the binding surface would then report a working bot as
  // undeliverable (add-mattermost-channel 1.1; Slack landed one day before the
  // declaration contract existed).
  outbound: { mode: "url-keyed" },

  credentialFields: [
    { key: "botToken", label: "Bot User OAuth Token (xoxb-…)", secret: true },
    { key: "signingSecret", label: "Signing Secret", secret: true },
    // Non-secret: the app/workspace entry URL an operator pastes from the
    // Slack admin console. Slack mints no follow-QR through its API.
    { key: "qrUrl", label: "Workspace entry URL (QR)", required: false },
  ],

  qr: { strategy: "manual", field: "qrUrl", hintKey: "botsPage.qr.hint.manual" },

  async verifyWebhook(req, cred) {
    // Signature first: nothing below runs on an unauthenticated body.
    checkSignature(req, cred);
    if (req.json?.type === "url_verification") return JSON.stringify({ challenge: req.json.challenge ?? "" });
    return null;
  },

  async parseMessage(req, _cred) {
    const body = req.json ?? {};
    // Only event callbacks carry messages; url_verification was handled above.
    if (body.type !== "event_callback") return null;
    const ev = body.event;
    if (!ev || ev.type !== "message") return null;
    // Our own (and any other bot's) messages must never re-enter the room.
    if (ev.bot_id || ev.subtype === "bot_message") return null;
    if (ev.subtype && !KEPT_SUBTYPES.has(ev.subtype)) return null;
    const text = typeof ev.text === "string" ? ev.text.trim() : "";
    if (!text || !ev.channel) return null;
    // thread_broadcast reports the ROOT ts in `ts`; the reply's own ts is the
    // one that identifies this message (`event_ts` is the canonical carrier).
    const ts = ev.event_ts || ev.ts || null;
    const threadRoot = ev.thread_ts ?? null;
    return {
      chatKey: threadRoot ? `${ev.channel}:${threadRoot}` : ev.channel,
      senderName: ev.user || ev.username || "unknown",
      text,
      platformMessageId: ts ? `${ev.channel}:${ts}` : null,
    };
  },

  async sendText(cred, chatKey, text) {
    const { channel, threadTs } = splitChatKey(chatKey);
    const payload = { channel, text };
    if (threadTs) payload.thread_ts = threadTs;
    const res = await postJson(`${API}/chat.postMessage`, payload, {
      authorization: `Bearer ${cred.botToken}`,
    });
    // Slack answers 200 with {ok:false, error} for every failure mode,
    // including a revoked token — the body is the only signal.
    if (!res.ok) throw new Error(`slack send failed: ${res.error ?? "unknown_error"}`);
    return res.ts ?? null;
  },

  // 中间态：先发占位，跑完后 chat.update 成答案（Slack 用 ts 定位消息，不是
  // message_id）。失败返 false，调度层回落到另发一条——答案不能因为编辑失败丢。
  ack: {
    mode: "edit",
    async placeholder(cred, chatKey, text) {
      const { channel, threadTs } = splitChatKey(chatKey);
      const payload = { channel, text };
      if (threadTs) payload.thread_ts = threadTs;
      const res = await postJson(`${API}/chat.postMessage`, payload, {
        authorization: `Bearer ${cred.botToken}`,
      });
      if (!res.ok) throw new Error(`slack ack failed: ${res.error ?? "unknown_error"}`);
      return res.ts ?? null;
    },
    async edit(cred, chatKey, messageId, text) {
      const { channel } = splitChatKey(chatKey);
      const res = await postJson(`${API}/chat.update`, { channel, ts: messageId, text }, {
        authorization: `Bearer ${cred.botToken}`,
      });
      return Boolean(res.ok);
    },
  },
};

// Self-check: round-trip the official signing scheme through verifyWebhook +
// parseMessage, and prove tampered/stale signatures and bot echoes are refused.
// Usage: node slack.js
if (process.argv[1]?.endsWith("slack.js")) {
  const { strict: assert } = await import("node:assert");
  const cred = { signingSecret: "s3cr3t", botToken: "xoxb-test" };
  const sign = (raw, ts = String(Math.floor(Date.now() / 1000))) => ({
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${crypto.createHmac("sha256", cred.signingSecret).update(`v0:${ts}:${raw}`).digest("hex")}`,
  });

  // 1. url_verification echoes the challenge.
  const handshake = JSON.stringify({ type: "url_verification", challenge: "abc123" });
  const echo = await registry.verifyWebhook({ headers: sign(handshake), raw: handshake, json: JSON.parse(handshake) }, cred);
  assert.equal(JSON.parse(echo).challenge, "abc123");

  // 2. A signed user message parses; a thread reply keys on channel:root.
  const msg = JSON.stringify({
    type: "event_callback",
    event: { type: "message", channel: "C1", user: "U9", text: " @智语 你好 ", thread_ts: "111.2", event_ts: "111.3" },
  });
  const parsed = await registry.parseMessage({ headers: sign(msg), raw: msg, json: JSON.parse(msg) }, cred);
  assert.deepEqual(parsed, { chatKey: "C1:111.2", senderName: "U9", text: "@智语 你好", platformMessageId: "C1:111.3" });

  // 3. A channel-level message (no thread) keys on the bare channel.
  const plain = JSON.stringify({ type: "event_callback", event: { type: "message", channel: "C1", user: "U9", text: "hi", ts: "1.1" } });
  assert.equal((await registry.parseMessage({ json: JSON.parse(plain) }, cred)).chatKey, "C1");

  // 4. Bot echoes and edits are ignored.
  for (const ev of [
    { type: "message", channel: "C1", text: "x", bot_id: "B1" },
    { type: "message", subtype: "bot_message", channel: "C1", text: "x" },
    { type: "message", subtype: "message_changed", channel: "C1", text: "x" },
  ]) {
    const raw = JSON.stringify({ type: "event_callback", event: ev });
    assert.equal(await registry.parseMessage({ json: JSON.parse(raw) }, cred), null, `ignored: ${ev.subtype ?? "bot"}`);
  }

  // 5. A tampered body and a stale timestamp are both refused.
  await assert.rejects(
    () => registry.verifyWebhook({ headers: sign(msg), raw: msg + " ", json: {} }, cred),
    /bad signature/,
  );
  await assert.rejects(
    () => registry.verifyWebhook({ headers: sign(msg, "1"), raw: msg, json: {} }, cred),
    /stale/,
  );

  // 6. chatKey splits back into what chat.postMessage needs.
  assert.deepEqual(splitChatKey("C1:111.2"), { channel: "C1", threadTs: "111.2" });
  assert.deepEqual(splitChatKey("C1"), { channel: "C1", threadTs: null });
  console.log("slack adapter self-check: 6/6 ok");
}
