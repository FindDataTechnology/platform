# Tasks

## 1. Forward-auth gate

- [x] `server.js`: parse `AUTH_MODE`; when `forward_auth`, middleware 401s any HTTP request without `X-Forwarded-Email`; attach `req.user = { email, groups }` (groups from comma-split `X-Forwarded-Groups`)
- [x] Gate the WS upgrade with the same rule
- [x] `GET /api/auth/me` → `{ mode, email, groups }`
- [x] `.env.example` + README: trust-boundary warning + the Caddy forward_auth snippet from design.md

## 2. Catalog module

- [x] `catalog.js`: load `agents.json` + fetch `AGENTS_CONFIG_URL`; validate entries (unknown type / duplicate id / chat entry missing `baseUrl`+`model` → drop + warn); merge by id (cloud wins); last-good on fetch failure
- [x] Refresh: `CATALOG_REFRESH_SECS` interval (default 60) + `POST /api/catalog/refresh` (requires `admin` group when auth on); content diff ⇒ `catalog_changed` WS broadcast
- [x] `GET /api/catalog`: role-filtered by `req.user.groups`; serializer whitelists display fields (no `apiKey`, no secrets)
- [x] `agents.example.json`; gitignore `agents.json`; `.env.example` entries (`AGENTS_CONFIG_URL`, `CATALOG_REFRESH_SECS`, `NANGO_SECRET_KEY`)

## 3. Remote chat streaming

- [x] WS `set_agent` / `agents` / `current_agent` / `agent_changed` (mirror the model-selection messages); reject switching while `isStreaming`
- [x] `streamRemoteChat(entry, prompt)`: POST `<baseUrl>/chat/completions` with `stream: true`, translate SSE deltas → `text` events, finish → `done`, failure → `error`; no chat-history persistence for remote agents

## 4. Apps + Nango broker

- [x] `POST /api/apps/:id/connect` for `nango-connect` entries: POST `<nangoUrl>/connect/sessions` (bearer `NANGO_SECRET_KEY`), tags `{end_user_id, end_user_email, organization_id}` from `req.user.email`, return Connect UI URL with `session_token` + `apiURL`; clear error when auth is off
- [x] `kind: "link"` app entries surface as plain URLs in the catalog payload

## 5. Web UI

- [x] `/agents` page: Agents & Apps sections from `/api/catalog`; link entries open externally; nango-connect entries call the broker then redirect; i18n keys in all five locales (en/zh-CN/es/fr/ja)
- [x] Chat-header agent switcher (local + chat-mode remotes); on `catalog_changed` refetch catalog + agent list

## 6. Tests

- [x] e2e: default `AUTH_MODE` unchanged; `forward_auth` 401 without headers / passes with headers (HTTP + WS); role filtering; secret redaction; `catalog_changed` fires when the cloud fixture changes; remote chat streams from a mock OpenAI-compat SSE server; broker against a stubbed `/connect/sessions`

## 7. Docs

- [x] CLAUDE.md + README: `AUTH_MODE`, catalog config schema + dual-source semantics, deployment sketch, v1 ceilings
