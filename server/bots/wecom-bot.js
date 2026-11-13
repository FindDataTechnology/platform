// 企业微信「智能机器人」(API-mode intelligent robot) adapter.
//
// NOT the self-built app (`wecom.js`) and NOT the group webhook robot: the
// group webhook can only PUSH, it has no inbound callback at all. The
// intelligent robot is the only WeCom object whose callback carries GROUP
// messages (chattype: single|group + the group chatid), which is what the
// group-chat capability needs (add-wecom-group-chat).
//
// The callback envelope (msg_signature over sorted(token,timestamp,nonce,
// ciphertext) + AES-256-CBC under EncodingAESKey) is the same platform-wide
// scheme as the self-built app — decrypt/signature/checkSignature are reused
// from wecom.js. The PLAINTEXT is expected to be JSON for this API-generation
// bot (fields per official docs: chattype, chatid, text.content, response_url);
// XML is still accepted as a fallback. Field names MUST be recalibrated
// against the first REAL callback before release (design D5): set
// WECOM_BOT_DEBUG=1 once and @-mention the bot in a test group — the decrypted
// plaintext is logged verbatim (first 2000 chars) and the parse result notes
// which fields it used.
//
// Replies: the callback carries a per-message `response_url` (passive reply,
// ~6min window). It is per-REQUEST, not per-bot, so it cannot ride the
// credentials: the adapter stashes the latest one per chatKey and sendText
// posts there. A reply whose turn outlives the window (or a proactive send
// with no prior inbound) fails LOUDLY — never silently swallowed.

import { decrypt, encrypt, signature } from "./wecom.js";
import { xmlField } from "./adapter.js";
import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";

const DEBUG = String(process.env.WECOM_BOT_DEBUG || "").trim() === "1";
// response_url: one call per url, valid 1h (official 主动回复消息 doc). The
// "6 minutes" figure is the passive-reply wait, not this window.
const RESPONSE_URL_TTL_MS = 60 * 60_000;

// chatKey → { url, at }. Latest callback wins: a group reply always goes to
// the same chat, so a slightly mismatched url still lands in the right place.
const responseUrls = new Map();

export function resetResponseUrlsForTest() {
  responseUrls.clear();
}
export function peekResponseUrlForTest(chatKey) {
  return responseUrls.get(chatKey) ?? null;
}

function noteResponseUrl(chatKey, url) {
  if (!chatKey || !url || !/^https?:\/\//.test(String(url))) return;
  responseUrls.set(chatKey, { url: String(url), at: Date.now() });
}

// The decrypted plaintext: JSON first (this API generation), XML fallback.
function parsePlaintext(plain) {
  const trimmed = String(plain ?? "").trim();
  if (trimmed.startsWith("{")) {
    try { return { json: JSON.parse(trimmed) }; } catch { /* fall through to XML */ }
  }
  if (trimmed.startsWith("<")) {
    const field = (tag) => xmlField(trimmed, tag);
    return { xml: {
      chattype: field("ChatType"),
      chatid: field("ChatId") ?? field("chatid"),
      from: field("FromUserName"),
      content: field("Content"),
      responseUrl: field("ResponseUrl"),
    } };
  }
  return null;
}

function chatKeyOf(json) {
  if (String(json.chattype).toLowerCase() === "group") return json.chatid ?? null;
  // single: the member id — several candidate field names until calibrated.
  return json.from?.userId ?? json.from?.userid ?? json.FromUserName ?? json.from ?? null;
}

function textOf(json) {
  const t = json.text?.content ?? json.content ?? json.Content;
  return typeof t === "string" ? t : null;
}

function senderOf(json, chatKey) {
  const from = json.from?.userId ?? json.from?.userid ?? json.FromUserName ?? json.from;
  return typeof from === "string" && from ? from : chatKey;
}

// Group mentions arrive inside the text ("@智语 帮我看下…") and pollute the
// prompt semantics; strip leading mention spans instead of matching the bot
// name (renames must not break the strip). Only-at-nothing → empty → dropped.
function stripGroupMentions(text) {
  let s = String(text ?? "");
  // Explicit mention structure if the platform provides one.
  const mentioned = json_mentioned ?? null;
  void mentioned;
  // Leading "@name" spans (unicode-safe: anything up to the first gap).
  s = s.replace(/^(?:\s*@[^\s@，。,;；！!？?：:]+)+\s*/u, "");
  return s.trim();
}
let json_mentioned = null; // set by parseMessage when a structured mention list exists

function debugLog(stage, payload) {
  if (!DEBUG) return;
  const head = typeof payload === "string" ? payload.slice(0, 2000) : JSON.stringify(payload)?.slice(0, 2000);
  console.log(`[wecom-bot][debug] ${stage}: ${head}`);
}

export const registry = {
  credentialFields: [
    // The WeCom admin console issues Token + EncodingAESKey for the callback;
    // corpId is the ReceiveId inside the decrypted envelope (verified when
    // present, optional until the first real callback confirms its casing).
    { key: "corpId", label: "CorpID（ReceiveId 校验用，可留空）", required: false },
    { key: "botId", label: "Bot ID" },
    { key: "token", label: "Callback Token", secret: true },
    { key: "encodingAesKey", label: "EncodingAESKey", secret: true },
  ],

  // No user-entry QR: members reach the robot via the org directory / group.
  qr: { strategy: "manual", field: "qrUrl", hintKey: "botsPage.qr.hint.manual" },

  async verifyWebhook(req, cred) {
    if (req.method === "GET") {
      const echostr = req.query.echostr;
      if (!echostr) throw new Error("missing echostr");
      wecomSignatureCheck(cred, req.query, echostr);
      return decrypt(cred.encodingAesKey, echostr).message;
    }
    // POST: the ciphertext rides XML (Encrypt) for app callbacks; this
    // generation may POST JSON (encrypt). Accept both, require exactly one.
    let encrypted = xmlField(req.raw, "Encrypt");
    let fromJson = false;
    if (!encrypted && req.json && typeof req.json === "object") {
      encrypted = req.json.encrypt;
      fromJson = Boolean(encrypted);
    }
    if (!encrypted) throw new Error("missing encrypted payload");
    wecomSignatureCheck(cred, req.query, encrypted, fromJson ? req.json : null);
    return null;
  },

  async parseMessage(req, cred) {
    const encrypted = xmlField(req.raw, "Encrypt") ?? req.json?.encrypt;
    if (!encrypted) return null;
    wecomSignatureCheck(cred, req.query, encrypted, req.json?.encrypt ? req.json : null);
    const { message: plain, receiveId } = decrypt(cred.encodingAesKey, encrypted);

    // Optional ReceiveId pin: a mismatched corp means the callback belongs to
    // another tenant — refuse rather than answer cross-tenant traffic.
    if (cred.corpId && receiveId && receiveId !== cred.corpId) {
      throw new Error(`receiveId mismatch: ${receiveId}`);
    }

    debugLog("plaintext", plain);
    const parsed = parsePlaintext(plain);
    if (!parsed) {
      debugLog("unparsed plaintext shape", plain);
      return null;
    }

    let chattype, chatKey, sender, rawText, responseUrl, mentions = null;
    if (parsed.json) {
      const j = parsed.json;
      chattype = String(j.chattype ?? "").toLowerCase();
      chatKey = chatKeyOf(j);
      sender = senderOf(j, chatKey);
      rawText = textOf(j);
      responseUrl = j.response_url ?? j.responseUrl ?? null;
      mentions = j.text?.mentions ?? null;
    } else {
      const x = parsed.xml;
      chattype = String(x.chattype ?? "").toLowerCase();
      chatKey = x.chatid && chattype === "group" ? x.chatid : x.from;
      sender = x.from;
      rawText = x.content;
      responseUrl = x.responseUrl;
    }
    json_mentioned = Array.isArray(mentions) ? mentions : null;

    debugLog("parsed", { chattype, chatKey, sender, rawText, hasResponseUrl: Boolean(responseUrl) });

    noteResponseUrl(chatKey, responseUrl);

    if (!chatKey) return null;
    if (typeof rawText !== "string") return null; // non-text (image/voice/file/event)
    const text = chattype === "group" ? stripGroupMentions(rawText) : rawText.trim();
    if (!text) return null; // @-only or whitespace: no turn
    const messageId = parsed.json ? (parsed.json.msgid ?? parsed.json.msgId ?? null) : (parsed.xml.msgid ?? null);
    return { chatKey, senderName: sender, text, platformMessageId: messageId ? String(messageId) : null };
  },

  // 事件回调（与自建应用适配器同一个理由）：`parseMessage` 把非文本一律回 null，
  // 于是一条 `msg_audit_approved`（客户撤回/授予存档同意）到了门口就被当噪音丢掉，
  // 存档侧继续按旧结论写最多 5 分钟。这里只把事件**认出来并交出明文**，不解释语义。
  //
  // 两代报文都收：XML 世代直接读标签；JSON 世代只读到"这是个事件"，**不猜内部字段**——
  // 把明文交回 `xml: ""`，由存档侧按"认不清就把水位记成全局"处理（下一轮对所有会话
  // 重查官方接口）。方向是安全的：宁可多问一次，也不拿没读懂的报文当结论。
  async parseEvent(req, cred) {
    const encrypted = xmlField(req.raw, "Encrypt") ?? req.json?.encrypt;
    if (!encrypted) return null;
    wecomSignatureCheck(cred, req.query, encrypted, req.json?.encrypt ? req.json : null);
    const { message: plain, receiveId } = decrypt(cred.encodingAesKey, encrypted);
    if (cred.corpId && receiveId && receiveId !== cred.corpId) {
      throw new Error(`receiveId mismatch: ${receiveId}`);
    }

    const trimmed = String(plain ?? "").trim();
    if (trimmed.startsWith("<")) {
      if (xmlField(trimmed, "MsgType") !== "event") return null;
      const event = xmlField(trimmed, "Event");
      if (!event) return null;
      return { event, xml: trimmed, from: xmlField(trimmed, "FromUserName") };
    }
    if (trimmed.startsWith("{")) {
      let j;
      try {
        j = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (String(j.msgtype ?? j.MsgType ?? "").toLowerCase() !== "event") return null;
      const ev =
        j.event?.event_type ??
        j.event?.type ??
        (typeof j.event === "string" ? j.event : null) ??
        j.Event ??
        null;
      if (!ev) return null;
      // 明文字段形状未经实证（机器人世代），只交事件名，xml 留空。
      return { event: String(ev), xml: "", from: j.from?.userId ?? j.FromUserName ?? null };
    }
    return null;
  },

  async sendText(_cred, chatKey, text) {
    const entry = responseUrls.get(chatKey);
    if (!entry || Date.now() - entry.at > RESPONSE_URL_TTL_MS) {
      if (entry) responseUrls.delete(chatKey);
      throw new Error(
        `wecom-bot: no live response_url for ${chatKey} ` +
        `(passive-reply window ~${Math.round(RESPONSE_URL_TTL_MS / 60000)}min since the last inbound; ` +
        "proactive sends to this channel are not supported)",
      );
    }
    // 主动回复 only accepts markdown / template_card — a "text" msgtype is
    // rejected with 40008 invalid message type (prod-verified). Plain text is
    // valid markdown, so text rides the markdown channel; in groups the reply
    // also quotes the triggering message (platform behavior, free win).
    // Outbound call discipline: shared deadline wrapper (default env bound).
    const res = await fetchWithTimeout(entry.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || (j.errcode && j.errcode !== 0)) {
      throw new Error(`wecom-bot send failed: ${res.status} ${j.errcode ?? ""} ${j.errmsg ?? ""}`.trim());
    }
  },
};

// Signature check delegating to the shared implementation — same sorted-join
// sha1 over (token, timestamp, nonce, ciphertext). Kept as a tiny wrapper so
// this file reads without importing the crypto internals.
function wecomSignatureCheck(cred, query, ciphertext, jsonBody = null) {
  const q = query ?? {};
  // JSON callbacks may carry the signature fields in the body instead of the
  // query string; accept both until the first real callback settles it.
  const effective = {
    timestamp: q.timestamp ?? jsonBody?.timestamp,
    nonce: q.nonce ?? jsonBody?.nonce,
    msg_signature: q.msg_signature ?? jsonBody?.msg_signature,
  };
  if (!effective.timestamp || !effective.nonce || !effective.msg_signature) {
    throw new Error("missing callback signature fields");
  }
  const expected = signature(cred.token, effective.timestamp, effective.nonce, ciphertext);
  if (expected !== effective.msg_signature) throw new Error("bad msg_signature");
}

// Self-check: mirror wecom.js's — build a signed+encrypted callback in BOTH
// shapes (JSON plaintext and XML plaintext), prove verify+parse accept them,
// and prove the group-mention strip and response_url reply path. Usage:
//   node server/bots/wecom-bot.js
if (process.argv[1]?.endsWith("wecom-bot.js")) {
  const { strict: assert } = await import("node:assert");
  const crypto = await import("node:crypto");
  const cred = {
    botId: "bot1",
    token: "T0KEN",
    encodingAesKey: crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43),
  };

  const envelope = (plainObj) => {
    const plain = typeof plainObj === "string" ? plainObj : JSON.stringify(plainObj);
    const enc = encrypt(cred.encodingAesKey, plain, "corpx");
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "n1";
    const sig = signature(cred.token, ts, nonce, enc);
    return { enc, query: { timestamp: ts, nonce, msg_signature: sig } };
  };

  // Group message, JSON plaintext, with a mention prefix and a response_url.
  const groupMsg = {
    chattype: "group",
    chatid: "wrAAAA1111",
    from: { userId: "alice" },
    text: { content: "@智语 帮我看下付款条款" },
    response_url: "https://qyapi.weixin.qq.com/cgi-bin/bot/response?k=1",
  };
  const post = { method: "POST", query: {}, raw: "", json: {} };
  let env = envelope(groupMsg);
  let req = { ...post, query: env.query, raw: JSON.stringify({ encrypt: env.enc }), json: { encrypt: env.enc } };
  assert.equal(await registry.verifyWebhook(req, cred), null);
  const parsed = await registry.parseMessage(req, cred);
  assert.deepEqual(parsed, { chatKey: "wrAAAA1111", senderName: "alice", text: "帮我看下付款条款" });
  assert.ok(peekResponseUrlForTest("wrAAAA1111")?.url.includes("k=1"), "response_url stashed per chat");

  // Reply goes to the stashed response_url.
  let posted = null;
  globalThis.fetch = async (url, opts) => {
    posted = { url: String(url), body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  await registry.sendText(cred, "wrAAAA1111", "看完条款了：付款周期 30 天。");
  assert.equal(posted.url, groupMsg.response_url);
  assert.deepEqual(posted.body, { msgtype: "markdown", markdown: { content: "看完条款了：付款周期 30 天。" } });

  // Send with no live response_url fails loudly.
  resetResponseUrlsForTest();
  await assert.rejects(() => registry.sendText(cred, "wrAAAA1111", "hi"), /no live response_url/);

  // Single-chat message: member-scoped chatKey, no mention strip.
  const singleMsg = { chattype: "single", from: { userId: "alice" }, text: { content: "私聊你好" } };
  env = envelope(singleMsg);
  req = { ...post, query: env.query, raw: JSON.stringify({ encrypt: env.enc }), json: { encrypt: env.enc } };
  const parsedSingle = await registry.parseMessage(req, cred);
  assert.deepEqual(parsedSingle, { chatKey: "alice", senderName: "alice", text: "私聊你好" });

  // @-only group message: dropped, no turn.
  env = envelope({ chattype: "group", chatid: "wrAAAA1111", from: { userId: "bob" }, text: { content: "@智语" } });
  req = { ...post, query: env.query, raw: JSON.stringify({ encrypt: env.enc }), json: { encrypt: env.enc } };
  assert.equal(await registry.parseMessage(req, cred), null);

  // XML plaintext fallback still parses.
  const xmlPlain = `<xml><ChatType><![CDATA[group]]></ChatType><ChatId><![CDATA[wrBBBB2222]]></ChatId><FromUserName><![CDATA[carol]]></FromUserName><Content><![CDATA[@智语 你好]]></Content><ResponseUrl><![CDATA[https://qyapi.weixin.qq.com/cgi-bin/bot/response?k=2]]></ResponseUrl></xml>`;
  env = envelope(xmlPlain);
  req = { ...post, query: env.query, raw: `<xml><Encrypt><![CDATA[${env.enc}]]></Encrypt></xml>`, json: undefined };
  assert.equal(await registry.verifyWebhook(req, cred), null);
  const parsedXml = await registry.parseMessage(req, cred);
  assert.deepEqual(parsedXml, { chatKey: "wrBBBB2222", senderName: "carol", text: "你好" });

  // Forged signature rejected.
  env = envelope(groupMsg);
  req = { ...post, query: { ...env.query, msg_signature: "deadbeef" }, raw: JSON.stringify({ encrypt: env.enc }), json: { encrypt: env.enc } };
  await assert.rejects(() => registry.verifyWebhook(req, cred), /bad msg_signature/);

  console.log("wecom-bot self-check: all assertions passed");
}
