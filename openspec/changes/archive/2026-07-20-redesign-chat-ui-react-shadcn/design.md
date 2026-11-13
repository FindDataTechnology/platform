# Design

## Context

The current frontend is `public/index.html` + `public/app.js` (~2,120 lines) + `public/style.css` (~1,574 lines), vanilla ES modules served by Express's static middleware at `/`. It talks to `server.js` over one WebSocket at `/` (documented WS event set: `prompt`, `text`, `thinking`, `tool_*`, `skill_use`, `models`, `documents_status`, `done`, `error`, etc.) and a set of REST endpoints under `/api/*`. There is no bundler, no framework, and no component boundary.

We are moving the **chat view** — sidebar + message log + composer — onto a React + shadcn/ui + Tailwind stack living under `web/`, keeping the other views (Documents, OpenConnector, Dashboard, LiteLLM) on the vanilla page for now. This is a frontend-only change: `server.js` and every backend module are untouched except for a small static-serving diff.

The migration must:
- **Preserve every WS event and REST contract** exactly. Existing behavioral specs (`chat-streaming`, `tool-use-rendering`, `model-selection`, `skill-invocation`, `chat-commands`, `foldable-observation-shortcut`, `app-navigation`) must still pass verbatim against the React frontend.
- **Not fork the page.** One page, one server, one WS connection. The vanilla views live under a hash/path route that the SPA hands off to server-served legacy assets; users see one URL.
- **Keep dev startup as one command.** `npm start` still works. Adding a second terminal is acceptable during heavy frontend work but not required.
- **Not break Electron.** `npm run dist` still produces a `.dmg` after adding one build step.

## Goals / Non-Goals

**Goals**
- A React chat surface visually comparable to Vercel AI Chatbot / Claude.ai — full-width messages, markdown + code highlighting, nested tool/thinking blocks under the assistant turn, composer with model select inside.
- A component library seeded (shadcn primitives) so subsequent view ports (Documents, OpenConnector, Dashboard) are additive, not further rewrites.
- Zero regression against existing WS/REST specs.
- Toolchain kept small: Vite + React + Tailwind v4 + shadcn CLI, nothing more.

**Non-Goals**
- Porting other views. Explicitly deferred.
- Changing the WS protocol, chat-history storage, or any backend contract.
- Server-side rendering, streaming SSR, or a Next.js migration. Plain SPA.
- Light-mode theming (tokens present, second theme deferred).
- New chat features (command palette, artifacts panel, right-click menu, message actions like edit/regenerate). Foundational only; features land in follow-up changes.
- Component tests. Existing E2E remains the safety net.

## Decisions

### D1. Stack: Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui + Zustand

**Alternatives considered:**
- **Next.js** — SSR/RSC unneeded for a WS-driven local app; adds build complexity and fights Electron packaging.
- **assistant-ui as a dependency** — nice primitives, but wraps state in ways that fight our WS-first model; we'd end up bypassing it. Lift patterns, don't depend.
- **Preact** — smaller runtime, but loses ecosystem parity with shadcn/Radix, which target React.
- **CSS Modules or vanilla-extract** instead of Tailwind — feasible, but shadcn assumes Tailwind and we lose the ability to install components with one CLI call.
- **Redux Toolkit** — Zustand covers the whole app state (WS connection, current session, messages, models, streaming flag) in tens of lines. RTK is overkill.

**Choice rationale:** every piece is what shadcn/v0 currently target (July 2026). Vite gives sub-second HMR. Tailwind v4 has no config file (`@theme` in CSS). shadcn's CLI drops components as source files under `src/components/ui/` — we own them, no runtime-dep upgrade churn. Zustand is 3KB, no boilerplate, WS-friendly (external store subscribe).

### D2. Repository layout: `web/` workspace at the repo root

```
PAAS/
├── server.js
├── public/                 # legacy views (Documents/OC/Dashboard/LiteLLM), untouched
│   ├── index.html          # kept: still serves non-chat views
│   ├── app.js              # chat portions removed at end of change
│   └── style.css           # chat portions removed at end of change
├── web/                    # NEW
│   ├── package.json        # its own dependencies
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.ts  # thin (v4 mostly uses @theme in CSS)
│   ├── components.json     # shadcn CLI config
│   ├── index.html          # Vite entry; served at /chat
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts       # WS connection + reconnect
│   │   │   └── useChatStore.ts       # Zustand store
│   │   ├── components/
│   │   │   ├── ui/                   # shadcn-installed primitives
│   │   │   ├── Sidebar.tsx
│   │   │   ├── SessionList.tsx
│   │   │   ├── ModelSelect.tsx
│   │   │   ├── Chat.tsx              # message log
│   │   │   ├── Message.tsx           # user | assistant
│   │   │   ├── ToolBlock.tsx
│   │   │   ├── ThinkingBlock.tsx
│   │   │   ├── SkillBlock.tsx
│   │   │   ├── Markdown.tsx          # react-markdown + shiki
│   │   │   └── Composer.tsx          # textarea + send + autocomplete
│   │   └── styles/globals.css        # @theme tokens
│   └── dist/                 # gitignored; build output
└── openspec/…
```

**Alternative rejected:** merge into `public/` and add a bundler build there. Confuses "legacy vanilla assets" with "built React output" — two categories, two directories.

**Alternative rejected:** monorepo (`packages/web`, `packages/server`, workspaces). Nothing to share; would inflate the change.

### D3. URL routing: `/chat` = React app, `/` = redirect, `/documents` etc. = legacy vanilla page

```
Browser hits          Server responds with
─────────────────     ─────────────────────────────────────────
/                  →  302 → /chat
/chat              →  web/dist/index.html   (React chat SPA)
/chat/*            →  web/dist/index.html   (SPA client routing later)
/documents         →  public/index.html     (legacy vanilla, opens #documents)
/openconnector     →  public/index.html     (legacy vanilla)
/dashboard         →  public/index.html     (legacy vanilla)
/litellm           →  public/index.html     (legacy vanilla)
/assets/*, /*.js   →  web/dist/assets/*     (React bundle assets)
/style.css, /app.js→  public/*              (legacy assets)
/api/*             →  unchanged
/oc-web/*          →  unchanged (OpenConnector reverse proxy)
WebSocket /        →  unchanged
```

The sidebar in the React chat SPA links to `/documents`, `/openconnector`, `/dashboard` via full-page navigation. When those views are ported in follow-up changes, they become SPA routes and the redirect disappears.

**Alternative rejected:** iframe the vanilla views inside the React shell. Two WebSocket connections, session-list divergence, and the reason we're doing this is to *stop* looking like it was made in 2019.

**Alternative rejected:** big-bang cutover — port all views in one change. Larger diff, longer feature freeze, more risk. Explicitly out of scope.

### D4. WebSocket integration: single connection managed by a Zustand store

- `useWebSocket()` hook mounts once at `App` level, opens `ws://<host>/`, auto-reconnects on close (existing behavior), and dispatches every message into the Zustand store.
- The store shape mirrors the current implicit `app.js` state: `{ status, messages, currentTurn, models, currentModel, sessions, isStreaming, documents, skills, docScopes }`.
- Reducer functions handle each incoming WS type — one function per event. Direct 1:1 port of the current `handleMessage` switch, but pure and testable.
- Streaming assistant text mutates the last message's `text` field; React re-renders that one component. No DOM ref juggling like the current `currentAssistantEl`.
- Outgoing sends (`prompt`, `list_models`, `set_model`, `list_skills`) are exposed as store actions.

**Rationale:** the current implementation is already a message-dispatched state machine hidden inside imperative DOM code. Zustand is the smallest thing that makes it explicit.

### D5. Markdown + code rendering

- `react-markdown` + `remark-gfm` for the markdown pipeline.
- `shiki` for syntax highlighting, `nord` (dark) theme to start; theme swappable later.
- Custom code-block component with a copy button that appears on hover.
- Assistant text is markdown. User text is plain (whitespace-preserving `<pre>`-styled but not parsed) — matches ChatGPT/Claude behavior; user might paste raw code they don't want interpreted.
- **Safety:** `react-markdown` doesn't render raw HTML by default; we do not enable `rehype-raw`. That closes the XSS surface without needing DOMPurify.

### D6. Message DOM: turns, not siblings

Current DOM structure:
```
#chat
├── .message.user
├── .thinking-block            ← sibling
├── .tool-block                ← sibling
├── .tool-block                ← sibling
└── .message.assistant
```

New structure:
```
<Chat>
├── <UserTurn>          text
└── <AssistantTurn>
    ├── <Header>        model name, timestamp
    ├── <Thinking>      collapsible, indented
    ├── <ToolCall>      collapsible, indented
    ├── <ToolCall>      collapsible, indented
    ├── <Markdown>      the actual text
    └── <Actions>       copy, retry (hover)
```

An `AssistantTurn` is opened when the server sends `agent_start`, all subsequent `text`/`thinking`/`tool_*`/`skill_use` events are appended into it, and it closes on `done`. This matches the semantic reality — one turn per model call — and reads far better.

### D7. Build & serve

**Dev (default `npm start`):**
- `server.js` serves `web/dist/index.html` and its assets from `web/dist/`. Frontend developers run `npm --prefix web run dev` in a second terminal, hitting Vite on `:5173`, which proxies WS/API to `:3000`. Everyone else uses the built dist.
- A `postinstall` script runs `npm --prefix web install && npm --prefix web run build` so `npm install` at the repo root leaves the project runnable without extra steps.

**Prod (`npm run dist`):**
- Runs `npm --prefix web run build` first, then `electron-builder`. The bundled Electron app includes `web/dist` as a normal `resources/` asset (already unpacked because `asar: false`).

**Alternative rejected:** run Vite from `server.js` itself in dev (Vite middleware mode). Adds Vite as a *runtime* dep of the Node server. Not worth it.

### D8. TypeScript, only in `web/`

- `web/` is strict-TS. `strict: true`, `noUncheckedIndexedAccess: true`.
- Root `server.js` and its modules stay `.js`. This is a frontend rewrite, not a codebase migration.
- WS message types live in `web/src/types/ws.ts` — a single source of truth for the message shapes. If server behavior changes, the types are the check.

### D9. Styling: Tailwind v4, one global stylesheet

- Tailwind v4 uses `@theme` in a CSS file (no `tailwind.config.ts` for theme, only for content paths and plugins). Tokens (`--color-bg`, `--color-fg`, `--color-accent`, radii, spacing) live in `web/src/styles/globals.css`.
- Dark-only for this change. Tokens are named so a `[data-theme="light"]` layer can be added later without touching components.
- shadcn components use the CSS variable palette (`hsl(var(--background))` pattern), so a theme swap is a one-file change.
- No CSS-in-JS.

### D10. State persistence

- Chat history persistence is server-side (`chat-history.js`). The React store subscribes to session-list REST endpoints exactly as today.
- Client-only state (sidebar collapsed?, last-selected model preference?) — none, this change. If we want it later: `localStorage` behind a Zustand persist middleware.

## Risks / Tradeoffs

- **The chat view breaks a WS-event scenario in translation.** Mitigation: keep the existing E2E suite green; add per-event checklist to `tasks.md`; explicitly walk `chat-streaming/spec.md`, `tool-use-rendering/spec.md`, `model-selection/spec.md`, `skill-invocation/spec.md`, `chat-commands/spec.md`, `foldable-observation-shortcut/spec.md` while implementing.
- **The page is briefly ugly during the transition.** For the duration of this change, `/chat` looks modern and the other tabs look old. Acceptable — they were about to look old regardless.
- **`postinstall` slows `npm install` and can fail behind a proxy.** Mitigation: honor the `http_proxy` env; document `PLATFORM_SKIP_WEB_BUILD=1` to skip. If `web/dist` already exists, skip build.
- **Bundle size.** shiki with many languages is large. Mitigation: register only a curated set of languages (`ts`, `js`, `python`, `bash`, `json`, `md`, `sql`, `html`, `css`, `diff`); lazy-import shiki so it does not block initial paint.
- **Electron asar/asarUnpack + Vite outputs.** `asar: false` is already the case (bundled Node needs it), so Vite outputs are readable as normal files — no new packaging landmine.
- **Font/rendering shift.** Tailwind's default `font-sans` (Inter or system stack via v4 defaults) differs slightly from the current `-apple-system, ..., sans-serif`. Kept close via `@theme --font-sans: ui-sans-serif, system-ui, …`; minor pixel-diff is expected and acceptable.
- **Contributor onboarding grows.** Frontend edits now need `npm --prefix web run dev`. Documented in `CLAUDE.md` and in `web/README.md`.

## Migration Plan

Sequenced so `/chat` is broken for no user at any commit point:

1. **Scaffold `web/` without wiring.** `npm --prefix web run build` produces a dist that renders "hello". Server still serves the vanilla chat at `/`. No user-visible change.
2. **Add the `/chat` route to `server.js`.** Users manually navigating to `/chat` see the React scaffold; `/` still serves the vanilla chat. Verify build + serve integration.
3. **Port the sidebar and session list.** Reuses REST endpoints; no WS wiring yet.
4. **Port the WS hook + Zustand store.** All events dispatched; no rendering yet — visible in devtools.
5. **Port `Chat` message log and streaming assistant bubble.** Simplest event set (`user`, `agent_start`, `text`, `done`).
6. **Port `ThinkingBlock`, `ToolBlock`, `SkillBlock` inside the turn.** Full WS event coverage.
7. **Port the `Composer`** — send, autocomplete, drop-target, model select-inside-card.
8. **Add markdown + shiki.** `Markdown` component; wire copy-on-hover.
9. **Switch `/` from vanilla chat to redirect → `/chat`.** Vanilla chat is now unreachable via `/`; users who bookmarked `/documents` etc. still land there.
10. **Delete chat sections of `public/app.js` + `public/style.css`.** Grep for any remaining chat-only symbols. Keep everything Documents/OC/Dashboard/LiteLLM needs.
11. **Update `CLAUDE.md`** to describe the `web/` architecture and the (small) build-step change.

Any commit in 1–9 is revertable by pulling that commit; the vanilla chat still exists on disk until step 10.

## Open Questions

- **Do we want a `/dev` flag to bypass the built dist and load Vite's dev server directly through `server.js`?** Nice-to-have; deferred unless someone asks.
- **Session URL sharing (`/chat/:sessionId`)?** Tempting free win from having a real routing story. Deferred — current app has no URL for a session, adding one is a separate spec change.
- **shadcn components list to preinstall?** Proposed: `button`, `scroll-area`, `command`, `select`, `tooltip`, `sheet`, `dialog`, `separator`, `input`, `textarea`, `dropdown-menu`, `toast`. Rest as needed.
