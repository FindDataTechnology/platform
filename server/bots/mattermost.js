// Mattermost adapter (add-mattermost-channel) — the eighth bot type, and the
// first one whose inbound leg needs no callback from the platform.
//
// Why this adapter exists: every existing WeCom leg is crippled on outbound in
// a way the operator cannot see (egress IP drift on the self-built app, a ~1h
// passive reply window on the intelligent bot), and the one leg that always
// delivers (the group webhook robot) cannot receive at all. A self-hosted
// Mattermost gives us the combination none of them have: ONE bot token that
// both receives and sends, with no caller-IP allowlist on either direction.
//
// ── Two inbound shapes, chosen by deployment, never both at once ────────────
//
//   subscribe (websocket)  we dial wss://<site>/api/v4/websocket and receive a
//                          push stream. Needs no public address; the shape is
//                          identical to Telegram's long-poll fallback, which is
//                          why it rides the existing `start()` hook in
//                          server/bots.js (that hook runs exactly when
//                          PUBLIC_BASE_URL is unset — today's production state).
//
//   callback (outgoing webhook)  the instance POSTs us at our public address,
//                          carrying its per-webhook `token` for verification.
//
// Both produce the same { chatKey, senderName, text, platformMessageId } and
// the same echo filtering, so the IM bridge and the room router never learn
// which one is in use.
//
// ── Why the callback path never answers inline ─────────────────────────────
//
// Mattermost's `OutgoingIntegrationRequestsTimeout` defaults to 30 SECONDS and
// applies to every outgoing integration request. A room turn (multiple seats,
// memory injection) routinely runs for minutes, so returning `{"text": …}` in
// the response is a guaranteed timeout. Raising the platform's timeout to
// minutes instead hangs an instance-wide HTTP worker per turn and slows every
// other integration. So: acknowledge the callback immediately, run the turn,
// and deliver with POST /api/v4/posts. The cost is that answers are not
// threaded under the triggering post by the platform — we thread them
// ourselves by deriving chatKey from the triggering post id (see parseMessage).
//
// ── Outbound capability ────────────────────────────────────────────────────
//
// `url-keyed`: the access token rides an Authorization header, Mattermost
// applies no caller allowlist, so an egress change cannot break delivery.
// Do not copy the `proactive-ip-gated` field from imports/wecom.js here.
//
// Docs: https://developers.mattermost.com/integrate/reference/personal-access-token/
//       https://developers.mattermost.com/integrate/webhooks/outgoing/

import crypto from "node:crypto";
import { postJson } from "./adapter.js";

// Slack/Telegram tighten nothing here: a Mattermost site URL is the operator's
// own instance. Trailing slash trimmed so `${site}/api/v4/...` never doubles it.
const siteOf = (cred) => String(cred?.siteUrl ?? "").trim().replace(/\/+$/, "");

/** `channel[:rootPostId]` → the two fields POST /api/v4/posts needs. */
export function splitChatKey(chatKey) {
  const s = String(chatKey ?? "");
  const i = s.indexOf(":");
  return i === -1 ? { channelId: s, rootId: null } : { channelId: s.slice(0, i), rootId: s.slice(i + 1) || null };
}

/** Constant-time compare of the instance-issued webhook token. */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  if (!b.length) return false; // unconfigured never authorizes
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The channels this bot is allowed to act in.
 *
 * Fail-closed (spec: mattermost-channel "入站可见面是显式声明的，不默认全量").
 * Membership alone is NOT a sufficient boundary on the callback shape: an
 * outgoing webhook is configured per channel and fires for messages the bot
 * never sees, so "we only get what we're in" is true for the websocket and
 * false for the webhook. An empty list therefore means "no channel", never
 * "all channels" — this instance also carries alerts and the ops surface, and
 * internal chatter must not fall into a guest-facing room router.
 */
export function allowedChannelsOf(cred) {
  const raw = cred?.allowedChannels;
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/);
  return new Set(list.map((x) => String(x).trim()).filter(Boolean));
}

// Which of the two inbound shapes this deployment can use. Exported because the
// pipeline test asserts the choice instead of trusting the wiring.
export function inboundShape(env = process.env) {
  return String(env.PUBLIC_BASE_URL ?? "").trim() ? "callback" : "subscribe";
}

export const registry = {
  // Receives AND sends; delivers without a caller allowlist.
  outbound: { mode: "url-keyed", inbound: true },

  credentialFields: [
    // The instance root, e.g. https://im.example.com — never a token.
    {
      key: "siteUrl",
      label: "实例地址 (https://…)",
      required: true,
      validate: (v) =>
        /^https?:\/\/[^\s]+$/.test(String(v ?? "").trim()) ? null : "实例地址必须是 http(s):// 开头的完整地址",
    },
    // Bot account token, minted by an admin. A password: masked everywhere.
    { key: "botToken", label: "Bot Access Token", secret: true },
    // Only needed on the callback shape; omitted when the server subscribes.
    { key: "webhookToken", label: "Outgoing Webhook Token（仅回调入站时需要）", required: false, secret: true },
    {
      // Fail-closed: empty means no channel acts, never "all channels".
      key: "allowedChannels",
      label: "参与的频道 ID（逗号分隔，留空则不处理任何频道）",
      required: false,
    },
    { key: "qrUrl", label: "入口链接 (QR)", required: false },
  ],

  // No QR is minted by Mattermost; the operator pastes the team entry URL.
  qr: { strategy: "manual", field: "qrUrl", hintKey: "botsPage.qr.hint.manual" },

  async verifyWebhook(req, cred) {
    // Nothing below runs on an unauthenticated body. Mattermost has no
    // signature scheme for outgoing webhooks — the shared `token` field IS the
    // authentication, and the docs say to validate it before trusting anything.
    const token = req.json?.token;
    if (!tokenMatches(token, cred?.webhookToken)) throw new Error("bad webhook token");
    // Outgoing webhooks have no URL-verification handshake, so there is never a
    // body to echo. null = "a real message to parse".
    return null;
  },

  async parseMessage(req, cred) {
    const body = req.json ?? {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || !body.channel_id) return null;
    // Fail-closed membership (spec: "入站可见面是显式声明的"): the callback shape
    // fires for channels this bot is not in, so membership cannot be the gate.
    if (!allowedChannelsOf(cred).has(String(body.channel_id))) return null;
    // Our own posts must never re-enter the room. A post made by the integration
    // itself carries no `user_id` at all — that is the practical echo signal, and
    // it is why the missing-user_id case returns null rather than a guess.
    if (!body.user_id) return null;
    if (cred?.botUserId && body.user_id === cred.botUserId) return null;
    // Thread key (D4): a reply inside a thread lands in the same conversation as
    // the post that opened it. Mattermost puts `root_id` on threaded replies and
    // on the root post itself exposes its own id in `post_id`.
    const rootId = body.root_id || null;
    const conversationId = rootId || body.post_id || null;
    return {
      chatKey: conversationId ? `${body.channel_id}:${conversationId}` : String(body.channel_id),
      senderName: body.user_name || body.user_id || "unknown",
      text,
      platformMessageId: body.post_id ? `${body.channel_id}:${body.post_id}` : null,
    };
  },

  async sendText(cred, chatKey, text) {
    const site = siteOf(cred);
    const token = String(cred?.botToken ?? "").trim();
    if (!site || !token) throw new Error("mattermost: siteUrl and botToken are required to send");
    const { channelId, rootId } = splitChatKey(chatKey);
    if (!channelId) throw new Error("mattermost: chatKey carries no channel");
    const body = { channel_id: channelId, message: String(text ?? "") };
    if (rootId) body.root_id = rootId;
    // postJson throws on any non-2xx and returns the parsed body on success, so
    // a revoked token or a missing channel surfaces as a real error rather than
    // a silent no-op.
    const created = await postJson(`${site}/api/v4/posts`, body, { authorization: `Bearer ${token}` });
    return created?.id ?? null;
  },

  // 中间态：占位 + PUT /posts/{id} 改写（Mattermost 的 post id 就是编辑句柄）。
  ack: {
    mode: "edit",
    async placeholder(cred, chatKey, text) {
      const site = siteOf(cred);
      const token = String(cred?.botToken ?? "").trim();
      if (!site || !token) throw new Error("mattermost: siteUrl and botToken are required");
      const { channelId, rootId } = splitChatKey(chatKey);
      if (!channelId) throw new Error("mattermost: chatKey carries no channel");
      const body = { channel_id: channelId, message: String(text ?? "") };
      if (rootId) body.root_id = rootId;
      const created = await postJson(`${site}/api/v4/posts`, body, { authorization: `Bearer ${token}` });
      return created?.id ?? null;
    },
    async edit(cred, _chatKey, messageId, text) {
      const site = siteOf(cred);
      const token = String(cred?.botToken ?? "").trim();
      if (!site || !token) return false;
      try {
        // Mattermost 的 PUT 要整条重写，id 必须在 body 里——不是只传新文本。
        await postJson(
          `${site}/api/v4/posts/${encodeURIComponent(messageId)}`,
          { id: messageId, message: String(text ?? "") },
          { authorization: `Bearer ${token}` },
        );
        return true;
      } catch {
        return false;
      }
    },
  },

  // ── subscribe (websocket) ────────────────────────────────────────────────
  // Runs only when the deployment has no public address (server/bots.js's
  // existing `adapter.start && !publicBaseUrl()` gate). Returns a stop function;
  // stop() MUST close the socket, because every bot config change calls reload()
  // → stop() → start(), and a socket left open leaks one connection per edit.
  start(bot, deliver) {
    const cred = bot.credentials ?? {};
    const site = siteOf(cred);
    const token = String(cred.botToken ?? "").trim();
    if (!site || !token) {
      console.warn(`[bots] mattermost "${bot.name}" cannot subscribe: siteUrl/botToken missing`);
      return () => {};
    }
    let stopped = false;
    let ws = null;
    let retryMs = 1000;
    let retryTimer = null;

    const connect = async () => {
      if (stopped) return;
      const { default: WebSocket } = await import("ws");
      const url = `${site.replace(/^http/, "ws")}/api/v4/websocket`;
      ws = new WebSocket(url);
      ws.on("open", () => {
        retryMs = 1000; // a successful open resets the backoff
        // Auth frame: the token is the same one sendText uses.
        ws.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } }));
      });
      ws.on("message", (buf) => {
        let ev;
        try { ev = JSON.parse(String(buf)); } catch { return; }
        if (ev?.event !== "posted") return; // typing/status/presence are noise
        const post = ev.data?.post ? safeParse(ev.data.post) : null;
        if (!post) return;
        const msg = fromPost(post, ev, cred);
        if (msg) deliver(msg);
      });
      ws.on("error", (err) => {
        if (stopped) return;
        console.warn(`[bots] mattermost subscribe (${bot.name}): ${err.message}`);
      });
      ws.on("close", () => {
        ws = null;
        if (stopped) return;
        // Backoff: an instance restart or a network blip both land here.
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      });
    };
    void connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      // terminate() rather than close(): a half-open socket from a dead instance
      // would otherwise keep the process alive to the end of its close timeout.
      try { ws?.terminate(); } catch { /* already gone */ }
      ws = null;
    };
  },

  // Factory defaults consumed by the future lane-config layer
  // (externalize-im-platform-adapters D4: adapters may export defaults, they
  // must NOT read them). Nothing in the business layer knows this field exists
  // today — that is the point, and grep is the proof.
  defaults: {
    copy: {
      // Room-side phrasing for this platform. Empty today on purpose: the
      // generic copy is correct until someone wants platform-specific wording.
      no_answer: "",
      quota_exhausted: "",
      session_ended: "",
    },
    timeouts: {
      // The platform's own outgoing-integration wait window (informational: we
      // acknowledge immediately, so this is not a limit we sit behind).
      integration_request_timeout_sec: 30,
      send_timeout_ms: 10_000,
    },
    dispatch: {
      // Which inbound shape this platform prefers when both are possible.
      // "callback" wins when a public address exists — see inboundShape().
      prefers: "callback",
    },
  },
};

function safeParse(json) {
  if (typeof json !== "string") return null;
  try { return JSON.parse(json); } catch { return null; }
}

// One websocket `posted` event → the canonical inbound message, or null.
function fromPost(post, ev, cred) {
  const text = typeof post.message === "string" ? post.message.trim() : "";
  if (!text || !post.channel_id) return null;
  // Same fail-closed gate as the callback shape. On the subscribe shape the
  // platform only pushes channels we're in, but keeping one rule for both shapes
  // is what makes "which channels" a declaration rather than a platform detail.
  if (!allowedChannelsOf(cred).has(String(post.channel_id))) return null;
  // Echo filter: a post from our own bot account must not re-enter the room.
  if (cred?.botUserId && post.user_id === cred.botUserId) return null;
  // bot posts always carry `props.from_bot`; a human post never does.
  if (post.props?.from_bot === "true" || post.props?.from_bot === true) return null;
  const rootId = post.root_id || null;
  const conversationId = rootId || post.id || null;
  return {
    chatKey: conversationId ? `${post.channel_id}:${conversationId}` : String(post.channel_id),
    senderName: ev.data?.sender_name || post.user_id || "unknown",
    text,
    platformMessageId: post.id ? `${post.channel_id}:${post.id}` : null,
  };
}

// Self-check: the credential boundary, both chatKey shapes, the echo filter and
// the inbound-shape choice. Usage: node server/bots/mattermost.js
if (process.argv[1]?.endsWith("mattermost.js")) {
  const { strict: assert } = await import("node:assert");
  const cred = { siteUrl: "https://im.example.com/", botToken: "tok", webhookToken: "whsec", botUserId: "bot1", allowedChannels: "C1" };

  // siteUrl normalization: a trailing slash must not produce a double slash.
  assert.equal(siteOf(cred), "https://im.example.com");

  // chatKey split round-trips what POST /api/v4/posts needs.
  assert.deepEqual(splitChatKey("C1"), { channelId: "C1", rootId: null });
  assert.deepEqual(splitChatKey("C1:P9"), { channelId: "C1", rootId: "P9" });

  // Token comparison: unconfigured never authorizes, wrong never authorizes.
  assert.equal(tokenMatches("whsec", "whsec"), true);
  assert.equal(tokenMatches("nope", "whsec"), false);
  assert.equal(tokenMatches("whsec", ""), false);
  assert.equal(tokenMatches("", ""), false);

  // Inbound shape: no public address → subscribe; with one → callback.
  assert.equal(inboundShape({}), "subscribe");
  assert.equal(inboundShape({ PUBLIC_BASE_URL: "https://x.example" }), "callback");

  // Callback parse: a threaded reply lands on the thread's conversation.
  const req = (json) => ({ json, headers: {}, raw: JSON.stringify(json), query: {} });
  const threaded = await registry.parseMessage(req({
    channel_id: "C1", post_id: "P9", root_id: "P3", user_id: "u1", user_name: "ada", text: "hi", token: "whsec",
  }), cred);
  assert.equal(threaded.chatKey, "C1:P3");
  assert.equal(threaded.senderName, "ada");
  assert.equal(threaded.platformMessageId, "C1:P9");

  // A channel-level post (no root) keys on its own id, so its replies join it.
  const root = await registry.parseMessage(req({
    channel_id: "C1", post_id: "P9", user_id: "u1", user_name: "ada", text: "hi", token: "whsec",
  }), cred);
  assert.equal(root.chatKey, "C1:P9");

  // Echo: our own bot's post and a post with no user_id both produce nothing.
  assert.equal(await registry.parseMessage(req({
    channel_id: "C1", post_id: "P9", user_id: "bot1", text: "answer", token: "whsec",
  }), cred), null);
  assert.equal(await registry.parseMessage(req({
    channel_id: "C1", post_id: "P9", text: "webhook body", token: "whsec",
  }), cred), null);

  // verifyWebhook: wrong/missing token throws, right token lets the message by.
  await assert.rejects(() => registry.verifyWebhook(req({ token: "nope" }), cred), /bad webhook token/);
  await assert.rejects(() => registry.verifyWebhook(req({}), cred), /bad webhook token/);
  assert.equal(await registry.verifyWebhook(req({ token: "whsec" }), cred), null);

  // sendText: assert the exact request (URL, bearer header, body). A real local
  // HTTP server is the seam — postJson is a module-scope import binding, so
  // monkey-patching it would test the patch rather than the call.
  const calls = [];
  const http = await import("node:http");
  const srv = http.createServer((rq, rs) => {
    let b = "";
    rq.on("data", (d) => { b += d; });
    rq.on("end", () => {
      calls.push({ url: rq.url, auth: rq.headers.authorization, body: JSON.parse(b || "{}") });
      rs.writeHead(201, { "content-type": "application/json" });
      rs.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await registry.sendText({ siteUrl: `http://127.0.0.1:${port}`, botToken: "tok" }, "C1:P9", "hello");
  srv.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v4/posts");
  assert.equal(calls[0].auth, "Bearer tok");
  assert.deepEqual(calls[0].body, { channel_id: "C1", message: "hello", root_id: "P9" });

  // start(): a local fake instance drives the real websocket path. This is the
  // only place in the repo where production code opens a websocket, so the
  // three properties that matter are asserted literally: a human post is
  // delivered once, our own bot's post is dropped, and stop() closes the socket
  // (a leaked connection per config edit is the failure mode that would only
  // show up as a slow leak in production).
  const { WebSocketServer } = await import("ws");
  const http2 = await import("node:http");
  const got = [];
  let serverSocketClosed = false;
  const fake = http2.createServer();
  const wss = new WebSocketServer({ noServer: true });
  fake.on("upgrade", (rq, sock, head) => {
    wss.handleUpgrade(rq, sock, head, (s) => {
      s.on("close", () => { serverSocketClosed = true; });
      // Auth ack, then three posted events: human, our bot, human again.
      s.send(JSON.stringify({ event: "hello", data: {} }));
      const post = (o) => JSON.stringify({ event: "posted", data: { post: JSON.stringify(o), sender_name: "ada" } });
      s.send(post({ id: "P1", channel_id: "C1", user_id: "u1", message: "first" }));
      s.send(post({ id: "P2", channel_id: "C1", user_id: "bot1", message: "our own answer" }));
      s.send(post({ id: "P3", channel_id: "C1", user_id: "u1", message: "second" }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const wsPort = fake.address().port;
  const stop = registry.start(
    { name: "probe", credentials: { siteUrl: `http://127.0.0.1:${wsPort}`, botToken: "tok", botUserId: "bot1", allowedChannels: "C1" } },
    (msg) => got.push(msg),
  );
  // Wait for both human posts to arrive (the event loop, not a fixed sleep).
  const deadline = Date.now() + 5000;
  while (got.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got.map((m) => m.text), ["first", "second"], "bot echo must not be delivered");
  assert.equal(got[0].chatKey, "C1:P1", "a channel-level post keys on its own id");
  assert.equal(got[0].platformMessageId, "C1:P1");
  stop();
  const closeDeadline = Date.now() + 3000;
  while (!serverSocketClosed && Date.now() < closeDeadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(serverSocketClosed, true, "stop() must close the socket");
  wss.close();
  fake.close();

  // Fail-closed membership: an undeclared channel is never processed, and an
  // empty declaration means none at all (not "all").
  assert.equal(await registry.parseMessage(req({
    channel_id: "OTHER", post_id: "P1", user_id: "u1", text: "elsewhere", token: "whsec",
  }), cred), null, "an undeclared channel must not be processed");
  assert.deepEqual([...allowedChannelsOf({})], [], "empty declaration = no channels");
  assert.deepEqual([...allowedChannelsOf({ allowedChannels: "C1, C2" })], ["C1", "C2"]);

  console.log("mattermost adapter self-check: 15/15 ok");
}
