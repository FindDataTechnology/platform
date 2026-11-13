# Proposal: add-forward-auth-agent-catalog

## Why

Platform today runs unauthenticated and exposes exactly one agent (the built-in pi session). The target deployment puts it behind our Logto SSO stack (Caddy forward_auth + oauth2-proxy, already live for nango/newapi), where every protected service shares one `.tokenvault.vip` SSO cookie. We want:

1. an **optional login** — when config enables it, PAAS honors the proxy-injected identity instead of running open;
2. an **Agents page** and a **bound third-party Apps view** (one combined page is acceptable);
3. **easy dual-source configuration** — entries in local config (alongside `.env`) and/or a cloud JSON URL; adding/removing entries there changes what clients see, live.

## What Changes

- New `AUTH_MODE=forward_auth`: PAAS trusts `X-Forwarded-Email` / `X-Forwarded-Groups` headers injected by a forward-auth proxy (Caddy + oauth2-proxy → Logto). No in-app OIDC client; a ~10-line middleware. Missing identity ⇒ 401. `AUTH_MODE` unset keeps today's open behavior.
- New catalog module with entries of three types — `agent-local` (the built-in session), `agent-remote` (OpenAI-compatible endpoints; `mode: "chat"` streams inside PAAS chat, `mode: "link"` just links out), and `app` (third-party bound apps; plain links or Nango connect-flow entries).
- Dual sources: `agents.json` (local, gitignored, sibling of `mcp.json`) + `AGENTS_CONFIG_URL` (cloud JSON, same schema). Merged by id (cloud wins), refreshed on an interval; changes broadcast `catalog_changed` over WS.
- Role visibility: entries may declare `roles[]`; an entry is served only when the authenticated user's groups intersect it (groups arrive via the verified Logto `roles`-claim path — same mechanism as the nango admin gate).
- Remote chat: WS `set_agent` + prompt fork to the entry's OpenAI-compat `/chat/completions` SSE, translated into the existing `text` / `done` / `error` events (frontend rendering unchanged).
- Nango connect broker: `app` entries of kind `nango-connect` get a server-side minted connect session (secret never leaves the server; `end_user_id` = requesting user's email), mirroring the proven connect-app flow.
- UI: one new `/agents` page (Agents & Apps) plus a chat-header agent switcher; secrets redacted from every client-facing catalog payload.

## Capabilities

| Capability | Section | Notes |
|---|---|---|
| `forward-auth` | ADDED | header-trust identity, opt-in via `AUTH_MODE` |
| `agent-catalog` | ADDED | entry types, dual-source merge, refresh + broadcast, role visibility, remote chat streaming, app broker, UI |

## Impact

- **Code**: `server.js` (middleware, WS fork, new routes), new `catalog.js` (mirrors `extension-store.js` patterns), `web/` new page + switcher. Default-off: zero behavior change unless `AUTH_MODE` / `agents.json` / `AGENTS_CONFIG_URL` are set.
- **Deploy**: enabling auth requires running behind a forward-auth proxy and binding PAAS so it is not directly reachable (the headers are trusted assertions).
- **Docs**: `.env.example`, `agents.example.json`, README auth + catalog sections.
- **Out of scope (v1 ceilings, documented in design)**: per-user session/data isolation (one shared session remains), remote-chat persistence into chat-history, in-app OIDC login, editing the catalog from the PAAS UI.
