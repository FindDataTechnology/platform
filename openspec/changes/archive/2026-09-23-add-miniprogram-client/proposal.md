# Add a WeChat mini-program chat client (Taro)

## Why

The product is browser-only today (React web + Electron desktop), but the target
users live on WeChat. The core ask is: chat works inside a WeChat mini program.
A mini program cannot reuse the web app's rendering stack (no DOM: no
react-markdown/shiki/mammoth/iframe), and its login flow cannot go through the
Logto browser redirect, so a thin dedicated client plus a small backend auth
path is required. Taro is chosen over uni-app because the codebase is React:
Taro (React 19 / Vite / Tailwind 4 / zustand) lets the WS protocol layer and
REST clients be extracted and shared with `web/` nearly verbatim instead of
rewritten in Vue.

## What Changes

- **New `miniapp/` Taro project** (React + TS + Tailwind + zustand): a thin
  client with Chat, session-history, and model/agent switching only. Admin
  surfaces (Extensions, Models config, Trace, Agents catalog management,
  Knowledge, Dashboard) stay web-only.
- **Shared core extracted** from `web/src` into a pure-TS package
  (`packages/core`): `types/ws.ts`, the WS client with backoff/reconnect, the
  REST API clients, and the chat store. `web/` re-imports from it — zero
  behavior change for the web app. (Refactor, not a spec delta.)
- **Mini-program auth path (account binding)**: first launch signs in with
  the platform (Logto) account on a login page; the gateway verifies via the
  password grant and binds the WeChat openid to the account. Later launches
  are silent `wx.login` exchanges; tokens carry the ACCOUNT identity, so the
  mini program and the browser share one cell per user.
- **Attachments ride the existing document-ingestion path**: the mini-program
  composer uploads through `POST /api/documents` (the web composer's exact
  multipart path) and references the ingested document as `@doc:<id>`, so the
  assistant can read it. No new upload endpoint.
- **Degraded rendering in the mini program by design**: markdown via mp-html
  (plain text while streaming, rendered markdown on turn completion), charts
  via a canvas-based ECharts adapter, no shiki (plain code blocks), no preview
  drawer (copy link instead).
- **Foreground reconnect**: the WS client reconnects on mini-program
  `onShow` (backgrounding kills sockets), reusing the shared backoff logic.

Non-goals: mobile native app (if ever needed, wrap the existing H5 with
Capacitor — do not use Taro's RN target); web-view shelling of the H5 app;
mini-program coverage of admin pages; WeChat pay/share.

## Capabilities

### New Capabilities

- `miniprogram-client`: the Taro mini-program thin client — chat streaming over
  the existing WS protocol, session history, model/agent switching, streaming
  markdown degradation, foreground reconnect, background-safe behavior.
- `miniprogram-auth`: WeChat login for mini-program clients — code exchange,
  platform token issuance and acceptance on REST + WS, openid-to-cell identity
  mapping, token lifetime/refresh.

### Modified Capabilities

- `cell-gateway`: the gateway authenticates traffic through **Logto for
  browsers and the WeChat mini-program token path for mini-program clients**;
  the existing requirement hard-codes Logto as the only identity provider.
  Routing/stickiness/reaping behavior is unchanged — an MP-authenticated user
  maps to the same per-user cell as an email-identity user.

## Impact

- **New code**: `miniapp/` (Taro project), `packages/core` (shared TS), MP
  login route in `gateway/` (code2Session needs `MP_APPID`/`MP_SECRET` env).
- **Modified**: `web/` imports shift to `packages/core` (no behavior change);
  `server/routes/files.js` or a new route gains the upload POST; gateway auth
  accepts a second token type.
- **Ops prerequisites (release-blocking, outside code)**: HTTPS/WSS endpoint
  with an ICP-registered domain, request/socket legal-domain configuration in
  the WeChat admin console, a registered mini-program appid.
- **Risks addressed up front by three spikes** (WS protocol round-trip in dev
  tools, streaming-markdown degradation UX, onShow reconnect) — placed first
  in tasks.md before any committed build-out.
