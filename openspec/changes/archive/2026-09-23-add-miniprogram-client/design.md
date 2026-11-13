# Design: add-miniprogram-client

## Context

The platform's sole frontend is the React SPA under `web/` (Vite + React 19 +
TS + Tailwind v4 + zustand), talking to `server.js` over one WebSocket (JSON
message protocol, `web/src/hooks/useWebSocket.ts`) plus `/api/*` REST
(`web/src/lib/*-api.ts`). The hosted topology fronts per-user cells with
`gateway/` (Logto browser login; identity headers trusted only from the
gateway). A mini program has no DOM (so react-markdown / shiki / mammoth /
iframe previews cannot run), kills sockets on backgrounding, requires
WSS + whitelisted ICP-registered domains for release, and cannot perform the
Logto redirect flow. Attachments already have a full ingress: the web
composer uploads to `POST /api/documents` (multipart, RAG ingestion) and the
prompt carries `@doc:<id>`, which the server expands into the agent's
context — the mini program reuses it verbatim.

## Goals / Non-Goals

**Goals:**

- Ship a WeChat mini program that carries the core chat loop (streaming
  chat, history, model/agent switching, attachments) against the *unchanged*
  WS + REST contracts.
- Make the protocol layer a shared asset, not a fork: one pure-TS core used
  by both `web/` and `miniapp/`.
- Add the MP identity path without touching any browser-facing behavior.

**Non-Goals:**

- Any change to web/Electron UX beyond the import reshuffle.
- MP coverage of admin surfaces (Extensions, Models config, Trace, Agents
  management, Knowledge, Dashboard).
- Native mobile app (deferred; if ever needed, Capacitor-wrapping the H5 —
  not Taro's RN target).
- WeChat pay/share; phone-number binding (later, on top of the token).

## Decisions

### D1: Taro, not uni-app — and a thin client, not a rewrite

uni-app is Vue-only; adopting it would mean rewriting ~11.5k lines of React
UI and still re-doing the rendering layer for the mini program (no DOM).
Taro runs React 19 + Vite + Tailwind 4 + zustand — the same stack as `web/`
— so only the rendering layer differs. Alternative rejected: native WXML
development (smallest bundle, zero build-layer dependency) — loses React
reuse and the shared-core story; not worth it for a 3-page client.

### D2: Shared core as a `file:`-linked private package `packages/core`

Moved from `web/src`: `types/ws.ts`, the WS client (connect/backoff/
reconnect, currently embedded in `useWebSocket.ts`), `lib/*-api.ts` REST
clients, and the chat store logic (`useChatStore.ts` state machine). The
package is pure TS with zero DOM and zero React imports at the transport
layer (zustand is plain JS and moves as-is). `web/package.json` and
`miniapp/package.json` both depend on it via `"file:../packages/core"`; npm
symlinks it and each bundler (Vite / Taro) compiles the TS directly. Lighter
alternative considered (tsconfig path aliases per project) — rejected: two
alias configs drift, and `file:` keeps `npm install` self-contained.

The WS transport becomes injectable: the core takes a `SocketFactory`
interface; `web/` passes `new WebSocket(...)`, `miniapp/` passes a Taro
`connectSocket` adapter (same event surface: open/message/close/error). The
React hooks (`useWebSocket`) stay per-project — they bind the transport to
each framework's lifecycle.

### D3: MP auth = account binding to Logto, not a standalone WeChat identity

The first cut minted tokens for a synthetic `wx_<hash>@mp.local` identity.
The product requirement (the user's own account system is the web's Logto,
data shared across ends) reshapes it into ACCOUNT BINDING:

- First launch: a mini-program login page submits platform credentials
  (username/phone + password) TOGETHER with a fresh wx.login code to
  `POST /api/mp/login-account`. The gateway runs code2Session (proves a real
  WeChat user + yields the openid) and verifies the credentials against
  Logto via the Resource Owner Password Grant (server-side client secret),
  reusing `verifyIdToken`/`mapGroups` from `server/logto-auth.js` on the
  returned ID token. The openid⇄account binding persists in
  `gateway/mp-bindings.js` (`<CELL_DATA_ROOT>/mp-bindings.json`, atomic
  temp+rename — gateway-level state because it must resolve BEFORE any cell
  exists).
- Every later launch: `POST /api/mp/login {code}` → binding lookup → token
  carrying the ACCOUNT email + groups — completely silent (openid reveals
  nothing personal, so WeChat allows no-UI exchange). Unbound openids get
  `404 binding_required`, which the client answers with the login page.
- Identity = the account email verbatim → the SAME `sha256(email)` cell as
  the browser session → shared data across ends for free.
- Token: hand-rolled HS256 JWT (`MP_TOKEN_SECRET`, TTL `MP_TOKEN_TTL_HOURS`,
  default 12h), `sub`=openid, `email`/`groups` from the binding. Expiry →
  silent re-exchange; a dropped binding → login-required event, not a
  generic disconnect.
- Logout: `DELETE /api/mp/bind` removes the binding.
- Direct-`server.js` deployments (dev / self-host, `AUTH_MODE=none`): no
  login at all — the probe returns 200 and the client connects anonymously.
- Unconfigured (`MP_APPID` unset): both endpoints report not-configured;
  every browser flow untouched.

**Why bind codes, not a password grant:** a live probe against the
deployment's Logto (v1.42) confirmed it does NOT implement the Resource
Owner Password Grant (`unsupported_grant_type`; OAuth 2.1 removed the flow,
and Logto's source registers only client-credentials / refresh-token /
token-exchange grants). Proxying Logto's internal sign-in APIs instead was
prototyped and rejected: the routes and payload shapes diverge from the
public docs (PUT vs POST, `passwordEncrypted` payloads), coupling the flow
to version internals. The bind code needs neither — the gateway's own web
session does the proving, no credential ever reaches the mini program, and
nothing outside this repo is on the critical path. The minted codes are
in-memory (5-minute TTL, single use); a gateway restart simply asks for a
fresh code. Local rehearsal without the real MP AppSecret:
`node scripts/dev-mp-gateway.mjs` (real gateway + real Logto, mock
code2Session mapping every wx.login code to one dev openid).

### D4: Streaming markdown — plain text while streaming, a bundled renderer on completion

Re-parsing markdown on every chunk is the classic mini-program perf trap
(partial fences/tables parse garbage and each parse re-renders a rich-text
tree). While streaming, render raw text into lightweight text nodes; on
`done`, parse the final message once.

The completion renderer is self-written (`src/lib/markdown.ts` +
`components/Markdown.tsx`), not mp-html: mp-html is a native npm component
requiring a devtools-side "构建 npm" step, which makes the build
unverifiable outside the GUI and couples release builds to an IDE. The
bundled parser covers exactly the spec'd subset (headings, paragraphs,
lists, quotes, code fences, pipe tables, links, bold/italic/inline code) and
emits Taro View/Text nodes — no HTML string is ever constructed, so there is
no injection surface. It is unit-tested under node (10 cases):
`src/lib/markdown.test.mjs`.

Charts likewise: a dependency-free canvas renderer for the four registered
series types (bar/line/pie/scatter) using the legacy
`Taro.createCanvasContext` API, drawn page-level after layout by the chat
page's effect. echarts-in-weapp needs a canvas adapter + a multi-hundred-KB
bundle for four chart types; ~200 lines cover the spec's contract, and a
draw failure flips the fence back to an ordinary code block (the spec'd
fallback). Fenced code blocks render monospace, un-highlighted (shiki stays
web-only: WASM + DOM + multi-MB grammars).

### D5: Attachments reuse the document-ingestion path — no new upload surface

A `POST /api/files` endpoint was prototyped and dropped during implementation:
it would store bytes under `uploads/`, which sits OUTSIDE the agent workspace,
so a reference to it is something the assistant cannot read — a generic
upload endpoint would have been a surface with no reader. The mp attachment
instead mirrors the web composer exactly: `Taro.uploadFile` → `POST
/api/documents` (multipart field `file`, the existing 50MB in-memory route) →
the response's doc `id` → the prompt appends `@doc:<id>`, which the server
expands into the agent's context. Non-extractable files still persist their
original with a preview reference, so the attach chip degrades exactly like
the web's. Verified against a live server: markdown ingestion returns
`{id, status:"ready", preview:{root,rel}}` with no LLM key involved.

### D6: Mini-program client structure

`miniapp/` Taro project, 2 pages + components: Chat (composer, stream view,
model/agent/preset pickers in the header — welcome state mirrors web),
Sessions (history list, read-only viewer). Styling is plain CSS per page:
weapp-tailwindcss would add a build-layer dependency for a two-page client
(see risks). Foreground reconnect: app
`onShow` → if socket dead, `reconnectNow()` (resets backoff, replays the
protocol's initial `list_*` queries) — the same seam the web's
`platform:reconnect` event uses, so the logic lives once in the core
package. Configurable API base URL + optional token in MP storage, so one
build serves dev (local server, devtools "skip domain check") and prod
(gateway URL).

## Risks / Trade-offs

- [Streaming feels less rich than web during the turn (no live markdown)] →
  accepted deliberately; plain-text-while-streaming is the spec'd behavior
  and the completion render is identical content.
- [Renderer re-parse of long conversations janks] → only completed messages
  parse; streaming text stays in cheap text nodes; the session viewer shows
  plain markdown parses with no interactivity beyond links.
- [echarts canvas wrapper fragility across WeChat base-library versions] →
  spec'd fallback to code block keeps the chat functional; wrapper validated
  in spike 2 before build-out.
- [code2Session requires the MP appid + a release channel with ICP domain] →
  ops track started in parallel; spikes run in devtools with domain check
  disabled, so no blocker for engineering.
- [MP JWT lives in mini-program storage] → sandboxed per-mini-program by
  WeChat; short TTL + silent refresh bounds exposure; `MP_TOKEN_SECRET`
  separate from `CELL_GATEWAY_SECRET` so leaking one doesn't forge the other.
- [Attachments depend on document ingestion (VOLCES key for full RAG)] →
  identical to the web composer's existing dependency; non-extractable files
  still attach with a stored original.
- [No Tailwind in the mini program: `weapp-tailwindcss` adds a build-layer
  dependency for a 2-page client] → plain SCSS per page; the shared core
  owns the logic, the rendering is small by design.
- [Shared-core extraction churns `web/` imports] → mechanical moves only,
  web e2e (Playwright) must stay green; any behavior delta is a bug.

## Migration Plan

Purely additive. Order: extract core (web still green) → upload endpoint →
gateway MP login (inert without env) → Taro client. Rollback = unset
`MP_APPID`/`MP_SECRET` (login route reports not-configured) and stop
publishing the MP; no data or schema changes. Deploy: set env on gateway,
upload the MP via WeChat devtools/CI after domain whitelisting.

## Open Questions

- Display name for WeChat users before any profile binding: v1 shows
  `微信用户` + short id hash; nickname/avatar via profile API or phone
  binding is a follow-up.
- Whether the Sessions page becomes a chat-history drawer on phones (UX
  polish; no contract impact).
