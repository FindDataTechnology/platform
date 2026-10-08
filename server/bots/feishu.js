// 飞书 / Lark custom-app adapter (event subscription v2).
//
// Verification order matters: signature first (when encrypt_key is set), then
// decrypt, then dispatch. The URL-verification handshake arrives on the same
// endpoint as real events, encrypted the same way, so it is handled after
// decrypt.
//
// Crypto: Feishu's encrypt_key scheme is AES-256-CBC with key = sha256(encrypt_key)
// and the IV as the first 16 bytes of the base64-decoded payload — NOT GCM (the
// change's design.md says GCM; the official spec is CBC and wins).
// Docs: open.feishu.cn/document/server-docs/event-subscription-guide

import crypto from "node:crypto";
import { postJson, tokenCache } from "./adapter.js";

const BASE = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";

function decrypt(encryptKey, b64) {
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(b64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString("utf8");
}

function checkSignature(headers, raw, encryptKey) {
  const ts = headers["x-lark-request-timestamp"];
  const nonce = headers["x-lark-request-nonce"];
  const sig = headers["x-lark-signature"];
  if (!ts || !nonce || !sig) throw new Error("missing signature headers");
  const expected = crypto.createHash("sha256").update(ts + nonce + encryptKey + raw).digest("hex");
  // Length-guarded timingSafeEqual: unequal lengths throw rather than compare.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad signature");
}

// Decrypted (or plaintext) request body as an object. Throws when undecryptable.
function payloadOf(req, cred) {
  const body = req.json ?? {};
  if (!cred.encryptKey) return body;
  if (typeof body.encrypt !== "string") throw new Error("expected encrypted payload");
  return JSON.parse(decrypt(cred.encryptKey, body.encrypt));
}

const tokens = new Map(); // appId → tokenCache
function tokenFor(cred) {
  let cache = tokens.get(cred.appId);
  if (!cache) {
    cache = tokenCache(async () => {
      const j = await postJson(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
        app_id: cred.appId,
        app_secret: cred.appSecret,
      });
      if (j.code !== 0) throw new Error(`tenant_access_token: ${j.msg}`);
      return { token: j.tenant_access_token, expiresInSec: j.expire };
    });
    tokens.set(cred.appId, cache);
  }
  return cache;
}

export const registry = {
  credentialFields: [
    { key: "appId", label: "App ID" },
    { key: "appSecret", label: "App Secret", secret: true },
    { key: "encryptKey", label: "Encrypt Key", required: false, secret: true },
    { key: "verificationToken", label: "Verification Token", required: false, secret: true },
    // Non-secret: the user-entry URL from the admin console, rendered as the
    // onboarding QR (self-built apps have no API-mintable follow QR).
    { key: "qrUrl", label: "User entry URL (QR)", required: false },
  ],

  // User-entry QR: manual link only — no platform API mints a follow QR for a
  // self-built app. The route renders the stored qrUrl as the code.
  qr: { strategy: "manual", field: "qrUrl", hintKey: "botsPage.qr.hint.manual" },

  async verifyWebhook(req, cred) {
    if (cred.encryptKey) checkSignature(req.headers, req.raw, cred.encryptKey);
    const payload = payloadOf(req, cred);
    if (cred.verificationToken) {
      const token = payload.token ?? payload.header?.token;
      if (token !== cred.verificationToken) throw new Error("verification token mismatch");
    }
    // URL-verification handshake: echo the challenge verbatim.
    if (payload.type === "url_verification") return JSON.stringify({ challenge: payload.challenge });
    return null;
  },

  async parseMessage(req, cred) {
    const payload = payloadOf(req, cred);
    if (payload.header?.event_type !== "im.message.receive_v1") return null;
    const msg = payload.event?.message;
    if (msg?.message_type !== "text") return null;
    let text = "";
    try { text = JSON.parse(msg.content).text || ""; } catch { return null; }
    if (!text) return null;
    return {
      chatKey: msg.chat_id,
      senderName: payload.event?.sender?.sender_id?.open_id || "unknown",
      text,
    };
  },

  async sendText(cred, chatKey, text) {
    const send = async () =>
      postJson(
        `${BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        { receive_id: chatKey, msg_type: "text", content: JSON.stringify({ text }) },
        { authorization: `Bearer ${await tokenFor(cred).get()}` },
      );
    let res = await send();
    // A revoked/expired token surfaces as a body code, not an HTTP status.
    if (res.code === 99991663 || res.code === 99991661) {
      tokenFor(cred).invalidate();
      res = await send();
    }
    if (res.code !== 0) throw new Error(`feishu send failed: ${res.code} ${res.msg}`);
  },
};

// Self-check: round-trip the official encrypt scheme through verifyWebhook +
// parseMessage, and prove a tampered signature is rejected.
// Usage: node feishu.js
if (process.argv[1]?.endsWith("feishu.js")) {
  const { strict: assert } = await import("node:assert");
  const encryptKey = "test-encrypt-key";
  const encrypt = (obj) => {
    const key = crypto.createHash("sha256").update(encryptKey).digest();
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([iv, c.update(JSON.stringify(obj), "utf8"), c.final()]).toString("base64");
  };
  const request = (obj) => {
    const raw = JSON.stringify({ encrypt: encrypt(obj) });
    const ts = "1700000000";
    const nonce = "abc";
    return {
      raw,
      json: JSON.parse(raw),
      headers: {
        "x-lark-request-timestamp": ts,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": crypto.createHash("sha256").update(ts + nonce + encryptKey + raw).digest("hex"),
      },
    };
  };
  const cred = { encryptKey };

  const challenge = request({ type: "url_verification", challenge: "ch-123" });
  assert.equal(await registry.verifyWebhook(challenge, cred), '{"challenge":"ch-123"}');

  const event = request({
    schema: "2.0",
    header: { event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_1" } },
      message: { chat_id: "oc_9", message_type: "text", content: '{"text":"hi"}' },
    },
  });
  assert.equal(await registry.verifyWebhook(event, cred), null);
  assert.deepEqual(await registry.parseMessage(event, cred), {
    chatKey: "oc_9", senderName: "ou_1", text: "hi",
  });

  const tampered = { ...event, headers: { ...event.headers, "x-lark-signature": "0".repeat(64) } };
  await assert.rejects(() => registry.verifyWebhook(tampered, cred), /bad signature/);
  console.log("OK feishu");
}
