# add-bot-relay-endpoint

## Why

Cloud-hosted services (the registry MCPs on the same host, e.g. `fd-*` and `law-bench`) need to push notifications through the configured chat-platform bots — "workflow finished", "daily digest" — without a human driving the web chat. Today the only outbound seam is `POST /api/bots/:id/send`, which is admin-gated behind interactive identity (logto session cookie): a machine caller cannot authenticate at all, and even if it could, `chatKey` is never persisted anywhere, so no caller could name a destination. The bots are (and must stay) configured on the always-on deployment (`fd-prod`), so the relay endpoint belongs there too.

## What Changes

- **Seen-chats recording**: the inbound bot pipeline upserts every verified message's `(bot, chatKey, senderName, lastSeenAt)` into a new `bot_chats` table. This is the missing record of "who has talked to this bot" — today the chatKey lives only in memory and is hashed irreversibly into the dsh session id.
- **Named channels**: an admin REST surface binds a channel name (e.g. `ops-alerts`) to one `(bot, chatKey)` pair from the seen-chats list. Callers address channels, never raw chat keys — the authorization surface is the admin's pre-binding, not the caller's choice.
- **Relay endpoint**: `POST /api/bots/relay/send { channel, text }` — exempt from proxy/logto identity (like the webhook routes), authenticated by its own bearer token (`BOTS_RELAY_TOKEN`, timing-safe compare), resolving the channel and delivering via the platform send API.
- **Outbound guards**: per-channel rate limit, message length cap, and an auditable record of every relay send (caller token identity, channel, outcome). Outbound sends currently have no rate limiting at all; a network-reachable entry point does not ship without them.
- **Credential v1**: a single `BOTS_RELAY_TOKEN` environment variable (k8s Secret → `envFrom`), rotated by `kubectl patch secret` + rollout restart — the same mechanism and weekly rhythm already in place for `MARKET_REGISTRY_TOKEN`.

Non-goals: multiple callers / per-caller revocable credentials (upgrade to a table when a second caller appears); channel-management UI (admin REST only in v1); public-internet exposure (see transport trust below); any change to the registry or the MCP servers themselves — they simply call the endpoint as their tool backend.

## Capabilities

### New Capabilities
- `bot-relay`: the machine-caller channel — relay endpoint with self-carried bearer authentication (exempt from proxy identity like bot webhooks), channel-name resolution to a pre-bound (bot, chatKey), outbound guards (rate limit, length cap, audit record), and token configuration/rotation semantics.

### Modified Capabilities
- `social-bot-channels`: the inbound pipeline gains the requirement to record seen chats — every verified inbound message upserts `(bot, chatKey, senderName, lastSeenAt)` server-side, making chat keys discoverable for channel binding; existing webhook, session, and trust-boundary behavior is unchanged.

## Impact

- **Server**: `server/auth.js` (add `/api/bots/relay/` to `AUTH_EXEMPT_PREFIXES`, each exempt path carrying its own auth per the existing convention); `server/bots.js` (seen-chat upsert in the inbound pipeline; guarded outbound send path); new relay route module under `server/routes/`; `db.js` migration for `bot_chats` + `bot_channels` (+ audit storage) following the transactional/idempotent migration convention.
- **REST**: new admin routes for channel-binding CRUD over seen chats; the relay send route (machine-facing).
- **Frontend**: none in v1 (channel management is admin REST; a Bots-page section is a follow-up).
- **Deployment (`fd-prod`, cheap1)**: `BOTS_RELAY_TOKEN` into `platform-secrets`; same-host callers (registry MCPs) reach the relay over loopback/node-local address. **Transport trust assumption**: the token must only travel over an operator-trusted network (loopback, private LAN, or a TLS-terminated ingress); standing up an HTTPS ingress for off-host public callers is ops work outside this change. Also check `PUBLIC_BASE_URL` while there — webhook platforms (WeCom/Feishu/WeChat OA) cannot receive inbound without it.
- **Callers**: each cloud MCP that wants outbound notification wraps `POST <platform>/api/bots/relay/send` as one tool, holding the shared token in its own server-side config.
