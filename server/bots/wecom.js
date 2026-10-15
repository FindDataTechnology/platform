// 企业微信 (WeCom) self-built-app adapter.
//
// Both the echo-verify handshake (GET) and real messages (POST) carry a
// msg_signature over sorted(token, timestamp, nonce, ciphertext); the payload
// itself is AES-256-CBC under the EncodingAESKey. Nothing is parsed before
// both checks pass.
//
// WeChat's AES envelope: key = base64(EncodingAESKey + "="), IV = key[0:16],
// plaintext = random(16) || msgLen(uint32 BE) || msg || receiveId, padded
// PKCS#7 to a 32-byte block (not 16 — hence setAutoPadding(false) + manual strip).
// Docs: developer.work.weixin.qq.com/document/path/90930

import crypto from "node:crypto";
import { xmlField, tokenCache } from "./adapter.js";

const BASE = process.env.WECOM_BASE_URL || "https://qyapi.weixin.qq.com";

function aesKey(encodingAesKey) {
  const key = Buffer.from(encodingAesKey + "=", "base64");
  if (key.length !== 32) throw new Error("EncodingAESKey must decode to 32 bytes");
  return key;
}

export function decrypt(encodingAesKey, b64) {
  const key = aesKey(encodingAesKey);
  const d = crypto.createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  d.setAutoPadding(false);
  const buf = Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]);
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) throw new Error("bad padding");
  const body = buf.subarray(16, buf.length - pad);
  const len = body.readUInt32BE(0);
  return { message: body.subarray(4, 4 + len).toString("utf8"), receiveId: body.subarray(4 + len).toString("utf8") };
}

export function encrypt(encodingAesKey, message, receiveId) {
  const key = aesKey(encodingAesKey);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(Buffer.byteLength(message));
  const body = Buffer.concat([crypto.randomBytes(16), len, Buffer.from(message), Buffer.from(receiveId)]);
  const pad = 32 - (body.length % 32);
  const c = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.concat([body, Buffer.alloc(pad, pad)])), c.final()]).toString("base64");
}

export function signature(token, timestamp, nonce, ciphertext) {
  return crypto.createHash("sha1").update([token, timestamp, nonce, ciphertext].sort().join("")).digest("hex");
}

function checkSignature(cred, query, ciphertext) {
  const expected = signature(cred.token, query.timestamp, query.nonce, ciphertext);
  if (query.msg_signature !== expected) throw new Error("bad msg_signature");
}

const tokens = new Map(); // corpId:agentId → tokenCache
function tokenFor(cred) {
  const k = `${cred.corpId}:${cred.agentId}`;
  let cache = tokens.get(k);
  if (!cache) {
    cache = tokenCache(async () => {
      const url = `${BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(cred.corpId)}&corpsecret=${encodeURIComponent(cred.corpSecret)}`;
      const j = await (await fetch(url)).json();
      if (j.errcode) throw new Error(`gettoken: ${j.errcode} ${j.errmsg}`);
      return { token: j.access_token, expiresInSec: j.expires_in };
    });
    tokens.set(k, cache);
  }
  return cache;
}

export const registry = {
  credentialFields: [
    { key: "corpId", label: "CorpID" },
    { key: "corpSecret", label: "App Secret", secret: true },
    { key: "agentId", label: "AgentId" },
    { key: "token", label: "Callback Token", secret: true },
    { key: "encodingAesKey", label: "EncodingAESKey", secret: true },
    // Non-secret: the user-entry URL from the admin console, rendered as the
    // onboarding QR (self-built apps have no API-mintable follow QR).
    { key: "qrUrl", label: "User entry URL (QR)", required: false },
  ],

  // User-entry QR: manual link only — no platform API mints a follow QR for a
  // self-built app. The route renders the stored qrUrl as the code.
  qr: { strategy: "manual", field: "qrUrl", hintKey: "botsPage.qr.hint.manual" },

  async verifyWebhook(req, cred) {
    // GET = the one-time URL echo-verify; the plaintext echostr is the reply.
    if (req.method === "GET") {
      const echostr = req.query.echostr;
      if (!echostr) throw new Error("missing echostr");
      checkSignature(cred, req.query, echostr);
      return decrypt(cred.encodingAesKey, echostr).message;
    }
    const encrypted = xmlField(req.raw, "Encrypt");
    if (!encrypted) throw new Error("missing Encrypt element");
    checkSignature(cred, req.query, encrypted);
    return null;
  },

  async parseMessage(req, cred) {
    const { message } = decrypt(cred.encodingAesKey, xmlField(req.raw, "Encrypt"));
    if (xmlField(message, "MsgType") !== "text") return null;
    const text = xmlField(message, "Content");
    const from = xmlField(message, "FromUserName");
    if (!text || !from) return null;
    return { chatKey: from, senderName: from, text };
  },

  async sendText(cred, chatKey, text) {
    const send = async () => {
      const url = `${BASE}/cgi-bin/message/send?access_token=${await tokenFor(cred).get()}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: chatKey,
          msgtype: "text",
          agentid: Number(cred.agentId),
          text: { content: text },
        }),
      });
      return res.json();
    };
    let j = await send();
    if (j.errcode === 40014 || j.errcode === 42001) { // invalid/expired access_token
      tokenFor(cred).invalidate();
      j = await send();
    }
    if (j.errcode) throw new Error(`wecom send failed: ${j.errcode} ${j.errmsg}`);
  },
};

// Self-check: build an official-shaped signed+encrypted callback with the same
// envelope WeCom uses, prove verify+parse accept it, and prove a tampered
// signature is rejected. Usage: node wecom.js
if (process.argv[1]?.endsWith("wecom.js")) {
  const { strict: assert } = await import("node:assert");
  const cred = {
    token: "QDG6eK",
    encodingAesKey: crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43),
    corpId: "wx5823bf96d3bd56c7",
  };
  const signed = (ciphertext) => ({
    msg_signature: signature(cred.token, "1409659813", "1372623149", ciphertext),
    timestamp: "1409659813",
    nonce: "1372623149",
  });

  const echostr = encrypt(cred.encodingAesKey, "1616140317555161061", cred.corpId);
  assert.equal(
    await registry.verifyWebhook({ method: "GET", query: { ...signed(echostr), echostr } }, cred),
    "1616140317555161061",
  );

  const inner =
    "<xml><ToUserName><![CDATA[wx5823bf96d3bd56c7]]></ToUserName>" +
    "<FromUserName><![CDATA[mycreate]]></FromUserName><CreateTime>1409659813</CreateTime>" +
    "<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>4561255354251345929</MsgId></xml>";
  const ciphertext = encrypt(cred.encodingAesKey, inner, cred.corpId);
  const post = {
    method: "POST",
    query: signed(ciphertext),
    raw: `<xml><ToUserName><![CDATA[wx]]></ToUserName><Encrypt><![CDATA[${ciphertext}]]></Encrypt></xml>`,
  };
  assert.equal(await registry.verifyWebhook(post, cred), null);
  assert.deepEqual(await registry.parseMessage(post, cred), {
    chatKey: "mycreate", senderName: "mycreate", text: "你好",
  });

  await assert.rejects(
    () => registry.verifyWebhook({ ...post, query: { ...post.query, msg_signature: "deadbeef" } }, cred),
    /bad msg_signature/,
  );
  console.log("OK wecom");
}
