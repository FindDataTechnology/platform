# Design — add-bot-relay-endpoint

## Context

See `proposal.md` for motivation and `specs/` for the behavior contract. The constraints below are what shape the approach; all were verified in the current code.

- **Bots already persist** in the `bots` table (migration v8): `id, type, name, enabled, secret, credentials, created_at`. Credentials are server-only and masked by `maskBot()` in every API response.
- **The chat key is never persisted.** It arrives with an inbound message and is hashed one-way into the dsh session id `bot-<botId>-<sha1(chatKey)16>` (`server/bots.js`). There is no record anywhere of which chats have talked to a bot.
- **Outbound already exists but only under browser identity**: `POST /api/bots/:id/send { chatKey, text }` → `sendTo(botId, chatKey, text)`, gated by `ctx.requireAdmin`. It requires the caller to already know the chat key, and it has **no rate limiting** (the inbound token bucket is only consulted in `handleMessage`).
- **Platform access tokens are cached per process**: `wecom.js`, `wechat-oa.js`, and `feishu.js` each keep a module-level `const tokens = new Map()`. WeChat OA's `gettoken` carries a hard daily quota. Telegram additionally runs a `getUpdates` long-poll loop inside `server/bots.js` when no `PUBLIC_BASE_URL` is set.
- **The exempt-route convention** (`server/auth.js`): `AUTH_EXEMPT_PREFIXES = ["/api/bots/webhook/"]`, with the explicit rule that each exempt path MUST carry its own authentication and that the list is not a public-route escape hatch.
- **Logto mode authenticates interactively only**: `authorization_code` + PKCE → signed `paas_session` cookie; `verifyIdToken` accepts RS256/ES256 and rejects HS256. There is no bearer-token path today.
- **The live deployment** is `fd-prod` on cheap1 (ArgoCD-synced k8s), env via ConfigMap `platform-config` + Secret `platform-secrets`; `MARKET_REGISTRY_TOKEN` already follows the "secret → envFrom → `kubectl patch` + rollout restart" rotation rhythm.

## Goals / Non-Goals

**Goals:**

- Give a machine caller on an operator-trusted network a send-only, channel-scoped, audited path into the existing bots, with no new credential owner and no new bot lifecycle.
- Make destinations administratively chosen and discoverable, closing the chat-key gap in the same change (recording seen chats).
- Ship with a kill switch that requires no code revert.

**Non-Goals:**

- Accepting inbound machine traffic other than this one send endpoint; no inbound reply path, no agent turn triggered by a relay call.
- Per-caller credentials, scopes, or revocation (deferred until a second caller exists).
- Channel management UI, HTTPS ingress provisioning, or any change to the existing admin send endpoint.
- Storing message content anywhere (inbound or outbound).

## Decisions

### D1. The relay runs inside the platform server process, not as a separate MCP child

The relay is a route in `server.js`'s app, delivering through the same adapter objects the reply path uses.

*Why:* adapters hold per-process token caches, and WeChat OA's token endpoint has a hard daily quota — a second process doubles that burn and makes the two caches invalidate each other (each side retries on 40014, so it flaps rather than fails). Worse, a second process that ran the bot lifecycle would start a competing Telegram `getUpdates` long-poll against the same bot token: Telegram answers 409 and messages are lost. Keeping the relay in-process means one credential owner, one token cache, one poller, one audit path.

*Alternatives considered:* (a) a stdio MCP server reading the same SQLite — the `server/library-mcp.js` pattern, which is correct for **read-only** access and stays the pattern for it, but wrong for writes for the reasons above; (b) a separate small relay service — same hazards, more moving parts.

### D2. Authentication: one deployment-injected bearer token on an exempt route

`BOTS_RELAY_TOKEN`, compared in constant time (reuse the existing `secretMatches` helper's approach from `server/auth.js`), on a route added to `AUTH_EXEMPT_PREFIXES` — the webhook precedent, which requires the exempt path to carry its own auth.

*Why this shape:* the caller is a machine on a trusted network; it cannot present a logto cookie, and extending logto to accept client-credentials bearers is a trust-boundary change for one caller. `DEPLOY.md` also records that the registry's own M2M account path is broken (IAM factory rejects `AUTH_PROVIDER=logto`), so the caller side cannot easily mint such a token anyway.

*Storage and rotation:* plain environment variable injected via the existing `platform-secrets` Secret — identical mechanism and weekly rhythm to `MARKET_REGISTRY_TOKEN`, no new operational motion.

*Kill switch:* unsetting the token makes the route inert (404). Disabling the feature needs no code revert; the tables simply go unused.

*Alternatives considered:* per-caller rows in a `bot_relays` table with an admin UI (deferred — no second caller yet); rejecting machine callers and inverting the direction so the platform polls the cloud (cannot work: the cloud's trigger timing is its own).

### D3. Destinations are named channels, bound by an administrator

A binding maps a unique channel name to one `(bot, chat key)`. The relay accepts only `{ channel, text }`; extra destination fields are ignored, so a caller cannot steer delivery.

*Why:* the shared token then authorizes only "send to destinations I already approved", never "send to any chat this bot has ever seen" — the blast radius of a leaked token is the bound channel list, not the customer list. It also makes the existing admin endpoint's requirement ("know the chat key") into an admin-side action performed once.

*Alternatives considered:* accepting a raw chat key (equivalent to the existing endpoint, but over a machine credential — rejected as too broad); per-caller channel scopes (deferred with D2).

### D4. Seen chats are recorded at the inbound entry point, in `bot_chats`

The verified inbound path upserts `(bot_id, chat_key)` with the sender display name and first/last-seen timestamps; failures are logged and never block the turn.

*Why:* it is the only way to make destinations discoverable — the dsh session id is a one-way hash of the chat key, so nothing else can reconstruct it. No message content is stored, matching the existing posture that replies carry the assistant's final text only.

*Alternatives considered:* deriving destinations by scanning the dsh session store (impossible — the hash is one-way); having the operator obtain chat keys out of band (no surface exposes them today).

### D5. Schema: migration v14 adds `bot_chats`, `bot_channels`, `bot_relay_log`

Three tables, no foreign keys (validated at the route; consistent with the existing hand-rolled style), applied through the existing transactional/idempotent migration runner and recorded in `schema_migrations`.

- `bot_chats(bot_id, chat_key, sender_name, first_seen_at, last_seen_at)` — primary key `(bot_id, chat_key)`.
- `bot_channels(name, bot_id, chat_key, created_at)` — primary key `name` (uniqueness is what makes the name authoritative).
- `bot_relay_log(ts, channel, bot_id, text_chars, outcome, error)` — audit.

*Why the audit stores text length and not text:* outbound notifications can carry sensitive content; the operator needs to know who sent what and whether it landed, not to accumulate a corpus of the messages.

*Alternatives considered:* reusing `trace_events` for audit — rejected, that table is turn-scoped (`turn_id`) and the relay deliberately runs no agent turn; a single table with a nullable channel column — rejected, seen-chats are churny telemetry while channels are few stable admin-owned rows.

### D6. Guards mirror the inbound pipeline's bounds

Per-channel rate limit of 10/min and a 4000-character text cap, as named constants next to the existing `RATE_LIMIT_PER_MIN` / `MAX_MESSAGE_CHARS`.

*Why:* those are already the project's chosen bounds for untrusted text moving through bot channels, and the relay is the first outbound path that needs a limiter at all.

### D7. A disabled bot refuses relay delivery (deliberate difference from the existing endpoint)

`sendTo()` today does not check `enabled` — `reload()` inserts a bot's runtime entry before its `if (!bot.enabled) return`, so the entry exists for disabled bots. For the relay, a channel whose bot is disabled is refused.

*Why:* a disabled bot means the operator took that channel out of service; a machine caller should not be the exception. The existing admin endpoint keeps its current behavior — changing it is out of scope.

## Risks / Trade-offs

- **[The token travels over an untrusted transport]** → v1 is scoped to callers on loopback/private networks (the registry MCPs share the platform's host). Off-host callers require an operator-provided TLS ingress; nothing in this change puts the token on the public internet by itself.
- **[A leaked or compromised cloud caller spams a bound channel]** → per-channel rate limit, length cap, and an audit row per attempt; the token cannot reach unbound chats, cannot receive replies, and cannot trigger an agent turn. Blast radius is "noise in the approved channels", and the kill switch is unsetting one variable.
- **[A relay send is indistinguishable from the operator's own bot message to the recipient]** → inherent to sending through the operator's bot identity; the audit row is the platform-side record. Mitigation is administrative (who gets the token), not technical.
- **[`bot_channels` bound to a stale chat key]** → the platform send fails at delivery and the failure is returned and recorded; the operator rebinds from the current seen-chats list.
- **[Seen-chats growth]** → bounded by distinct chats per bot, rows are tiny; no pruning in v1.
- **[Concurrent admin writes to `bot_channels`]** → SQLite serialization plus the unique channel-name constraint.
- **[Inbound webhook platforms still cannot receive without `PUBLIC_BASE_URL` on fd-prod]** → deployment checklist item carried in the proposal's Impact; the relay itself works regardless.

## Migration Plan

1. **Deploy the code.** Migration v14 applies at boot (transactional, idempotent, existing rows untouched). Relay is inert until step 2, so deploy order is safe.
2. **Enable on fd-prod.** `kubectl --context cheap -n fd-prod patch secret platform-secrets` to add `BOTS_RELAY_TOKEN`, then `rollout restart` + `rollout status`. Also verify `PUBLIC_BASE_URL` while there, so webhook platforms receive inbound (which is what populates `bot_chats`).
3. **Bind channels.** After at least one message has been recorded for the target chat, create bindings through the admin REST routes.
4. **Wire the caller.** Put the same token in the cloud MCP's server-side config and wrap `POST <platform>/api/bots/relay/send` as its tool.
5. **Rollback.** Unset `BOTS_RELAY_TOKEN` and restart — the route goes inert and no code revert is needed. The tables remain as inert leftovers; dropping them is optional and not required for rollback.

## Open Questions

- Whether to add a channel-management section to the Bots page (admin REST only in v1).
- Whether a second caller will need per-caller credentials — the upgrade path is a `bot_relays` table with the same bearer semantics, no spec change.
- Whether off-host callers are needed at all, which decides if an HTTPS ingress is worth standing up.
