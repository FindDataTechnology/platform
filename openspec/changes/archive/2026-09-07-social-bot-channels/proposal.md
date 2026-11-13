## Why

The platform's agent currently has exactly one front door: the web chat. Users want to reach the same dsh agent from the chat tools they already live in — 企业微信 (WeCom), 飞书 (Feishu/Lark), Telegram, and WeChat-family bots. Every one of these is a **webhook-in / API-reply-out** loop around the agent we already run:

```
platform user ──▶ bot config UI (tokens, verify webhooks)
                       │ persists to SQLite
external chat ──▶ POST /api/bots/:id/webhook/<secret>
                       │ verify signature (per-platform)
                       │ resolve channel+sender → dsh session id
                       ▼
                 ctx.dshBridge.prompt(sessionId, …)   ◀── same pipe the web chat uses
                       │ notifications (existing pump)
                       ▼
                 final assistant text → platform send-message API
```

Two directions, only one is new: **outbound** (agent → chat platform messaging, e.g. proactive notifications) is largely covered by the existing OpenConnector integration (1000+ SaaS actions); **inbound** (platform → agent → reply) is the missing module and the whole of this change.

Platform notes scoped in exploration:
- **企业微信** (self-built app): callback URL with AES-encrypted echo-verify + message decrypt; replies via the send-message API using corpid/secret/ticket. Official, stable.
- **飞书** (custom app / bot): event subscription with URL verification challenge, `encrypt_key` decryption, event callbacks; reply via im/v1 messages using app token. Official, stable.
- **Telegram**: BotFather token + `setWebhook` (or getUpdates polling when no public URL); replies via `sendMessage`. Official, simplest.
- **微信公众号** (official-account customer-service messages): signature + XML/JSON bodies, 48h reply window. Official.
- **个人微信** has no official API (ToS-violating hacks only) — **excluded**; users who say "微信" usually mean one of the two official channels above.

## What Changes

- New `server/bots.js`: registry + inbound pipeline. Bot configs live in a new SQLite table (`bots`: id, type, name, credentials blob, enabled, per-bot session policy). Graceful degradation: the module is inert until a bot is configured; each bot starts/stops independently; a failing bot logs and never blocks the server.
- Per-platform adapters (`server/bots/`): `wecom.js`, `feishu.js`, `telegram.js`, `wechat-oa.js`. Each implements one interface: `{ verifyWebhook(req) → ok/echo, parseMessage(body) → { chatKey, senderName, text, replyToken? }, sendText(config, chatKey, text) }`. Telegram adapter handles both webhook and polling modes. Each adapter validates signatures/decrypts BEFORE anything reaches the agent (trust boundary).
- Inbound flow: `POST /api/bots/webhook/:botId/:secret` (secret in path so platforms that can't send headers still authenticate; per-bot random secret generated at config time). Message → session resolution (see design) → `dshBridge.prompt()` on that session → the existing event pump produces the final text (captured via the assistant/message event already translated in dsh-events.js) → adapter `sendText()` back to the originating chat. One in-flight turn per bot chat; concurrent messages to the same chat queue (the durable inbox already orders them); messages to different chats run in parallel sessions.
- Session model: each (bot, external chat id) maps to its own dsh session id (`bot-<botId>-<chatKey>` hashed), persisted in the bots table — isolated conversations per chat, resumable from dsh's disk persistence. **Not** the shared web session.
- Config UI: new `/bots` page (nav entry "Bots / 机器人") — list, create/edit per type (credential fields per platform), enable/disable toggle, webhook URL display (copy button), delete. Credentials stored server-side only and never serialized to the browser (existing tokens-never-reach-the-browser convention; API returns masked hints).
- Outbound proactive send: minimal REST `POST /api/bots/:id/send { chatKey, text }` (admin-gated under forward_auth) so cron/skills can push to a configured chat. Generic platform-action needs stay on OpenConnector — not duplicated here.
- Under `AUTH_MODE=forward_auth`, webhook routes are exempt from the proxy-injected header requirement (external platforms cannot send it) — they authenticate via their own platform signature/secret instead.

## Capabilities

### New Capabilities
- `social-bot-channels`: inbound bot webhooks, per-chat sessions, reply delivery, config UI, and the outbound send API.

### Modified Capabilities
- `app-navigation`: sidebar gains the Bots entry (and the i18n strings that entails).

## Impact

- **Backend**: new `server/bots.js` + `server/bots/*.js` adapters, `server.js` (mount webhook + config routes, init), `db.js` (bots table + chat-session mapping), crypto for wecom AES (Node stdlib `crypto` — no new deps; feishu uses AES-GCM stdlib; telegram/wechat-oa are HMAC/XML only).
- **Frontend**: new `web/src/pages/BotsPage.tsx`, `web/src/lib/bots-api.ts`, Sidebar entry, locales ×5.
- **Public network requirement**: wecom/feishu/webchat-oa webhooks need the server reachable on HTTPS with a valid cert (existing Caddy/forward-auth deployment pattern); Telegram works via polling with no public URL — the adapter picks polling when no public base URL is configured.
- **Risk — prompt-through-external-input**: bot messages are untrusted input to an agent with tools. v1 mitigations: per-chat allowlists (default: bot answers but tools require the platform user to be mapped — v1 ceiling: tools disabled for bot sessions by default, env `BOTS_ALLOW_TOOLS=1` to enable), message length cap, rate limit (per-chat token bucket).
- **Sequencing note**: trace-viewer (separate change) makes bot turns inspectable; independent, but doing it first/second pays off here.
