# Design — social-bot-channels

## D1. One adapter interface, four implementations

Every platform reduces to three functions; everything else is per-platform plumbing:

```ts
interface BotAdapter {
  // WeCom echo-verify / Feishu URL challenge / Telegram setWebhook check:
  // returns the literal body to reply with, or null when it's a real message.
  verifyWebhook(req, config): Promise<string | null>
  // External payload → canonical inbound message.
  parseMessage(body): { chatKey, senderName, text } | null   // null = ignore (edits, reactions, echoes)
  // Canonical text → that platform's send API (uses config credentials).
  sendText(config, chatKey, text): Promise<void>
}
```

| Platform | Verify | Parse | Send |
|---|---|---|---|
| wecom (自建应用) | AES(GBK echo) decrypt w/ EncodingAESKey | XML decrypt → text msg | POST qyapi message/send (access_token from corpid+secret) |
| feishu (custom app) | JSON `{challenge}` echo, encrypt_key AES-GCM | event v2 callback → im message | POST im/v1/messages (tenant_access_token) |
| telegram | setWebhook silently (200 on any) | update → message.text | POST sendMessage (bot token) |
| wechat-oa | signature check (SHA1 token+ts+nonce), echostr | XML msg → text | POST cgi-bin/message/custom/send (access_token) |

Crypto is Node stdlib (`crypto`: aes-256-cbc, aes-256-gcm, sha1/hmac). XML parsing: tiny hand-rolled extractor (the wecom/wechat XML is flat `<xml><ToUserName><![CDATA[…]]></…>`), not a dependency. Feishu/Telegram payloads are JSON.

Token caching: access_token/tenant_access_token expire (~2h); adapters cache per bot with expiry and refresh on 400/401. No shared cache layer — a Map per adapter instance.

## D2. Sessions: per (bot, chatKey), never the web session

```
session id = "bot-" + botId + "-" + sha1(chatKey).slice(0, 16)
```

dsh persists sessions by id and resumes from disk, so each external chat is a durable independent conversation. The chat-history sidebar lists web sessions only — bot sessions bypass chat-history persistence (their transcript of record is the external platform; trace-viewer covers inspection). Mapping is derived, not stored — no extra table; a chat's history lives in dsh's session store.

Concurrency: one dsh runtime, one shared notification pump — so turns from different chats interleave at the event layer. The pump must therefore be **session-aware**: today `handleDshEvent` assumes THE one session (broadcasts everything to every WS client). Fix: dsh notifications carry the session id; `handleDshEvent` routes web-session events to the existing broadcast path and bot-session events to the bot pipeline's per-session collector (prompt() → collect assistant text until session idle → sendText). This is the one place existing code changes semantics — `ctx.dshSessionId` filtering moves from implicit-single to explicit-match, keeping the web path byte-compatible.

Reply capture: listen for `assistant/message` (final text, already emitted by the runtime) + `session.status idle` per session, collect last assistant text, send, done. Errors mid-turn → send a short error message to the chat (configurable off).

## D3. Trust boundary: platform auth first, agent exposure second

1. Webhook route auth: `/api/bots/webhook/:botId/:secret` — the per-bot secret defeats id-guessing; platform signature/decrypt verifies the payload itself (wecom AES, feishu encrypt_key/signature, telegram optional secret_token header, wechat-oa signature). Unverified → 403, never logged with content.
2. Under `forward_auth`, webhook routes are exempt from `X-Forwarded-Email` (external platforms can't send it); they MUST NOT be reachable except through the platform-verified path above. The exemption list is explicit in code, not a blanket public flag.
3. Agent tool exposure: bot sessions get a **read-only system posture** in v1 — prompts run with tools disabled (`BOTS_ALLOW_TOOLS=1` env lifts this for trusted deployments). Message cap 4k chars, per-chat rate limit (10 msgs/min token bucket). These are trust-boundary guards, not features — they stay boring and centralized in the inbound pipeline before prompt().
4. Reply content: assistant final text only; never tool output/raw events.

## D4. Config storage & UI

SQLite `bots` table: `id, type, name, enabled, credentials (JSON, server-only), created_at`. API shape mirrors the extensions page: list (masked credentials — type-specific "configured" hints), create/update (credential fields validated per adapter before save), delete, enable toggle. Webhook URL shown with copy button (`{PUBLIC_BASE_URL}/api/bots/webhook/{id}/{secret}` — `PUBLIC_BASE_URL` env or window.location origin). No new WS events; config changes take effect without server restart (adapter instances keyed by bot id, rebuilt on save).

Telegram polling fallback: if `PUBLIC_BASE_URL` unset/self-signed, adapter runs `getUpdates` long-poll loop per bot (interval 3s, stops on disable/delete). One loop per Telegram bot, capped by bot count in practice.

## Alternatives rejected

- **Route everything through OpenConnector** — it's outbound-only for these platforms (execute actions), has no inbound webhook hosting; we'd still write all the inbound code and gain a hop.
- **Per-bot dsh child processes** — one child per chat platform burns RAM for no isolation benefit; the runtime already multiplexes sessions (and restart-model-switch resumes all from disk).
- **Bot framework library (botpress/grammY/wecom lib)** — four platforms × one tiny interface each ≈ less code than one framework's config surface; zero deps preferred (bundling/Electron constraints).

## Addendum — deviations found during implementation

**A1. Feishu uses AES-256-CBC, not GCM.** D1 says "encrypt_key AES-GCM". The official
scheme is AES-256-**CBC** with `key = sha256(encrypt_key)` and the IV as the first 16
bytes of the base64 payload. `server/bots/feishu.js` implements CBC; its self-check
round-trips the real envelope.

**A2. Tools cannot actually be disabled per session (D3.3 is weaker than specified).**
The spec requires bot turns to "run without tool execution" unless `BOTS_ALLOW_TOOLS`
is set. dsh exposes **no per-session or per-prompt tool control** — the runtime
auto-allows every tool its profile's plugins declare, and `session/prompt` takes only
`{sessionId, contentBlocks}`. There is no cancel RPC either. What is implemented
instead, in `server/bots.js`:

1. **Prompt-level posture** — an explicit "do not call any tools" instruction is
   prepended to every bot prompt.
2. **Reply-side enforcement** — the turn collector watches for `tool/call`; if a bot
   turn used tools under the no-tools posture, the assistant's answer is **withheld**
   and the chat gets a refusal instead.

So a tool can still *execute*; its output can never *reach* the external chat. That
satisfies the observable scenario ("tool calls absent from bot turn") but not the
literal requirement. Closing the gap needs either a dsh per-prompt tool allowlist or a
separate tool-less profile spawned for bot sessions. **The spec text should be amended
to match, or this listed as a v1 ceiling.**

**A3. The global JSON body parser had to be excluded from the webhook path.**
`server.js` mounts `express.json()` before all routes; it consumes the request stream,
which left webhook handlers with an empty body — breaking XML platforms entirely and
Feishu's signature (which is computed over the bytes as sent). The parser now skips
`WEBHOOK_PREFIX`. Any future global body middleware must do the same.
