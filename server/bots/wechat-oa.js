// 微信公众号 (WeChat Official Account) adapter — customer-service replies.
//
// Verification is the classic sha1 over sorted(token, timestamp, nonce); the
// GET handshake echoes `echostr`, POSTs carry a flat plaintext XML message.
// Replies go out as customer-service messages, which WeChat only permits
// within 48h of the user's last message — a send outside that window fails
// with errcode 45015 and is surfaced as a normal send error.
//
// v1 ceiling: plaintext callback mode only. 安全模式 (AES) uses the same
// envelope as WeCom — reuse `wecom.js`'s decrypt/signature if it's needed.
// Docs: developers.weixin.qq.com/doc/offiaccount/Message_Management

import crypto from "node:crypto";
import { postJson, xmlField, tokenCache } from "./adapter.js";

const BASE = process.env.WECHAT_OA_BASE_URL || "https://api.weixin.qq.com";

function checkSignature(cred, query) {
  const expected = crypto
    .createHash("sha1")
    .update([cred.token, query.timestamp, query.nonce].sort().join(""))
    .digest("hex");
  if (query.signature !== expected) throw new Error("bad signature");
}

const tokens = new Map(); // appId → tokenCache
function tokenFor(cred) {
  let cache = tokens.get(cred.appId);
  if (!cache) {
    cache = tokenCache(async () => {
      const url = `${BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cred.appId)}&secret=${encodeURIComponent(cred.appSecret)}`;
      const j = await (await fetch(url)).json();
      if (j.errcode) throw new Error(`token: ${j.errcode} ${j.errmsg}`);
      return { token: j.access_token, expiresInSec: j.expires_in };
    });
    tokens.set(cred.appId, cache);
  }
  return cache;
}

export const registry = {
  credentialFields: [
    { key: "appId", label: "AppID" },
    { key: "appSecret", label: "AppSecret", secret: true },
    { key: "token", label: "Callback Token", secret: true },
  ],

  // User-entry QR: a permanent (QR_LIMIT) scene QR minted via qrcode/create;
  // the browser gets the public showqrcode URL, never the access token.
  // Only verified service accounts accept the call — an unsupported account
  // type or API error throws, and the route falls back to the manual-link state.
  qr: {
    strategy: "wechat-qrcode",
    hintKey: "botsPage.qr.hint.wechatOa",
    async resolve(cred) {
      const create = async () =>
        postJson(
          `${BASE}/cgi-bin/qrcode/create?access_token=${await tokenFor(cred).get()}`,
          { action_name: "QR_LIMIT_STR_SCENE", action_info: { scene: { scene_str: `entry:${cred.appId}` } } },
        );
      let j = await create();
      if (j.errcode === 40014 || j.errcode === 42001) { // invalid/expired access_token
        tokenFor(cred).invalidate();
        j = await create();
      }
      if (j.errcode) throw new Error(`qrcode/create: ${j.errcode} ${j.errmsg}`);
      if (!j.ticket) throw new Error("qrcode/create returned no ticket");
      return { url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(j.ticket)}` };
    },
  },

  async verifyWebhook(req, cred) {
    checkSignature(cred, req.query);
    // GET = the one-time URL handshake; echo echostr verbatim.
    return req.method === "GET" ? String(req.query.echostr ?? "") : null;
  },

  async parseMessage(req) {
    if (xmlField(req.raw, "MsgType") !== "text") return null;
    const text = xmlField(req.raw, "Content");
    const from = xmlField(req.raw, "FromUserName");
    if (!text || !from) return null;
    return { chatKey: from, senderName: from, text };
  },

  async sendText(cred, chatKey, text) {
    const send = async () => {
      const url = `${BASE}/cgi-bin/message/custom/send?access_token=${await tokenFor(cred).get()}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ touser: chatKey, msgtype: "text", text: { content: text } }),
      });
      return res.json();
    };
    let j = await send();
    if (j.errcode === 40014 || j.errcode === 42001) { // invalid/expired access_token
      tokenFor(cred).invalidate();
      j = await send();
    }
    if (j.errcode) throw new Error(`wechat-oa send failed: ${j.errcode} ${j.errmsg}`);
  },
};

// Self-check: the documented handshake + a real-shaped text message parse, and
// a forged signature rejected. Usage: node wechat-oa.js
if (process.argv[1]?.endsWith("wechat-oa.js")) {
  const { strict: assert } = await import("node:assert");
  const cred = { token: "weixin" };
  const query = (extra = {}) => {
    const q = { timestamp: "1409659813", nonce: "1372623149", ...extra };
    q.signature = crypto.createHash("sha1").update([cred.token, q.timestamp, q.nonce].sort().join("")).digest("hex");
    return q;
  };

  assert.equal(
    await registry.verifyWebhook({ method: "GET", query: query({ echostr: "ech-1" }) }, cred),
    "ech-1",
  );

  const raw =
    "<xml><ToUserName><![CDATA[toUser]]></ToUserName><FromUserName><![CDATA[fromUser]]></FromUserName>" +
    "<CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType>" +
    "<Content><![CDATA[this is a test]]></Content><MsgId>1234567890123456</MsgId></xml>";
  const post = { method: "POST", query: query(), raw };
  assert.equal(await registry.verifyWebhook(post, cred), null);
  assert.deepEqual(await registry.parseMessage(post), {
    chatKey: "fromUser", senderName: "fromUser", text: "this is a test",
  });

  const image = { ...post, raw: raw.replace("text", "image") };
  assert.equal(await registry.parseMessage(image), null);
  await assert.rejects(
    () => registry.verifyWebhook({ ...post, query: { ...post.query, signature: "bad" } }, cred),
    /bad signature/,
  );
  console.log("OK wechat-oa");
}
