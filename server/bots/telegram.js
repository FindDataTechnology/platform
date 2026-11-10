// Telegram Bot API adapter.
//
// Webhook mode: Telegram POSTs the raw Update JSON. Its only authentication is
// the optional `secret_token` (echoed back as X-Telegram-Bot-Api-Secret-Token),
// which we require whenever the operator configured one; the per-bot secret in
// the webhook path is the always-on guard.
//
// Polling mode: when the server has no public base URL, `start()` runs a
// getUpdates long-poll loop instead. One loop per Telegram bot.
// Docs: https://core.telegram.org/bots/api#getupdates / #sendmessage

import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";

const API = "https://api.telegram.org";
const POLL_TIMEOUT_SEC = 25;
// Long-poll headroom: getUpdates parks the connection for POLL_TIMEOUT_SEC by
// design, so its deadline must exceed the poll window, not the shared default.
const POLL_TIMEOUT_MS = (POLL_TIMEOUT_SEC + 5) * 1000;
const CALL_TIMEOUT_MS = 10_000;

const api = (token, method) => `${API}/bot${token}/${method}`;

async function call(token, method, body, timeoutMs = CALL_TIMEOUT_MS, signal = undefined) {
  // Outbound call discipline: shared deadline wrapper — per-call override
  // keeps the long-poll lane above its own 25s window. `signal` lets the poll
  // loop cancel a parked getUpdates on shutdown instead of waiting it out.
  const res = await fetchWithTimeout(api(token, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  }, { timeoutMs });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description || res.status}`);
  return json.result;
}

// Update → canonical inbound message. Non-text updates (edits, callbacks,
// joins, stickers) return null so the pipeline ignores them.
function toMessage(update) {
  const m = update?.message;
  const text = m?.text;
  if (!m?.chat?.id || !text) return null;
  return {
    chatKey: String(m.chat.id),
    senderName: m.from?.username || [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || "unknown",
    text,
    platformMessageId: m.message_id != null ? String(m.message_id) : null,
  };
}

export const registry = {
  credentialFields: [
    { key: "token", label: "Bot token (BotFather)", secret: true },
    { key: "secretToken", label: "Webhook secret token (optional)", required: false, secret: true },
  ],

  // User-entry QR: the username comes from getMe, so the token never leaves
  // the server. Throws on a rejected token — the route turns that into the
  // panel's failure state, bot management keeps working.
  qr: {
    strategy: "telegram-me",
    hintKey: "botsPage.qr.hint.telegram",
    async resolve(cred) {
      const me = await call(cred.token, "getMe", {});
      if (!me?.username) throw new Error("telegram getMe returned no username");
      return { url: `https://t.me/${me.username}` };
    },
  },

  async verifyWebhook(req, cred) {
    if (cred.secretToken && req.headers["x-telegram-bot-api-secret-token"] !== cred.secretToken) {
      throw new Error("secret token mismatch");
    }
    return null; // Telegram has no URL-verification handshake.
  },

  async parseMessage(req) {
    return toMessage(req.json);
  },

  async sendText(cred, chatKey, text) {
    await call(cred.token, "sendMessage", { chat_id: chatKey, text });
  },

  // Polling fallback. `deliver(message)` runs one agent turn; failures are
  // logged and the loop keeps going (a poisoned update must not kill intake).
  start(bot, deliver) {
    let stopped = false;
    let offset = 0;
    let abortPoll = null;
    const loop = async () => {
      while (!stopped) {
        try {
          const controller = new AbortController();
          abortPoll = () => controller.abort();
          const updates = await call(bot.credentials.token, "getUpdates", {
            offset,
            timeout: POLL_TIMEOUT_SEC,
            allowed_updates: ["message"],
          }, POLL_TIMEOUT_MS, controller.signal);
          for (const u of updates) {
            offset = u.update_id + 1;
            const msg = toMessage(u);
            if (msg) deliver(msg);
          }
        } catch (err) {
          if (stopped) return;
          console.warn(`[bots] telegram poll (${bot.name}): ${err.message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
    loop();
    // Stopping must also cancel the in-flight long poll. `stopped = true` alone
    // leaves a getUpdates request parked for its full 25s window, and that
    // pending socket keeps the process alive — the unit suite's bots file never
    // exited because of it (CI unit step → 1h hang → cancelled rollouts,
    // 2026-11-09). Abort the request so shutdown is immediate and complete.
    return () => {
      stopped = true;
      abortPoll?.();
    };
  },
};

// Self-check: parse a real-shaped Update, and prove non-text updates are
// ignored + the secret-token gate rejects a mismatch. Usage: node telegram.js
if (process.argv[1]?.endsWith("telegram.js")) {
  const { strict: assert } = await import("node:assert");
  const update = {
    update_id: 1,
    message: {
      message_id: 7,
      from: { id: 42, first_name: "Ada", username: "ada" },
      chat: { id: -100123, type: "group" },
      date: 1700000000,
      text: "hello bot",
    },
  };
  const parsed = await registry.parseMessage({ json: update });
  assert.deepEqual(parsed, { chatKey: "-100123", senderName: "ada", text: "hello bot" });
  assert.equal(await registry.parseMessage({ json: { update_id: 2, edited_message: {} } }), null);
  assert.equal(await registry.verifyWebhook({ headers: {} }, { token: "t" }), null);
  await assert.rejects(() =>
    registry.verifyWebhook({ headers: { "x-telegram-bot-api-secret-token": "nope" } }, { secretToken: "s" }));
  console.log("OK telegram");
}
