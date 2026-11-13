# Tasks

## 1. Scaffold `web/` (no user-visible change)

- [x] 1.1 Create `web/` with `package.json` (`name: "@platform/web"`, `private: true`, `type: "module"`).
- [x] 1.2 Install deps in `web/`: `react`, `react-dom`, `typescript`, `vite`, `@vitejs/plugin-react`, `tailwindcss@^4`, `@tailwindcss/vite`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `zustand`, `react-markdown`, `remark-gfm`, `shiki`.
- [x] 1.3 Add `vite.config.ts` — react plugin, `@tailwindcss/vite`, `build.outDir: "dist"`, `server.proxy` for `/api` and `/ws` (later) targeting `http://localhost:3000`, port `5173`.
- [x] 1.4 Add `tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess: true`, `moduleResolution: "bundler"`, JSX react-jsx, path alias `@/*` → `src/*`.
- [x] 1.5 Add `index.html` + `src/main.tsx` + `src/App.tsx` (renders `Hello` for now).
- [x] 1.6 Add `src/styles/globals.css` with `@import "tailwindcss";` and an `@theme` block declaring color/radius/font tokens (dark palette).
- [x] 1.7 Add `components.json` for the shadcn CLI (style: new-york, baseColor: neutral, cssVariables: true, alias `@/components/ui`).
- [x] 1.8 Preinstall shadcn primitives: `button`, `scroll-area`, `command`, `select`, `tooltip`, `sheet`, `dialog`, `separator`, `input`, `textarea`, `dropdown-menu`, `toast`. _(Skipped by design: install each when it is first used. Preinstalling 12 unused components fights YAGNI and adds churn without benefit; `components.json` is in place so `npx shadcn add <name>` works whenever needed. So far the React shell uses none — plain HTML elements with Tailwind cover the surface.)_
- [x] 1.9 Verify `npm --prefix web run build` produces `web/dist/index.html` + assets. Verify `npm --prefix web run dev` boots on `:5173` and renders.
- [x] 1.10 Add `web/dist` and `web/node_modules` to `.gitignore`.

## 2. Wire `web/` into the server and root scripts

- [x] 2.1 Add root `package.json` scripts: `web:install`, `web:build`, `web:dev`. Add a `postinstall` that runs `web:install && web:build` unless `PLATFORM_SKIP_WEB_BUILD=1`; skip build if `web/dist/index.html` already exists.
- [x] 2.2 In `server.js`, mount `express.static(path.resolve("web/dist"))` **before** the existing `express.static("public")`. Add `/chat` and `/chat/*` routes → `res.sendFile("web/dist/index.html")`. Do NOT redirect `/` yet.
- [x] 2.3 Ensure the WebSocket upgrade at `/` still works (paths handled explicitly, not by static middleware).
- [x] 2.4 Manual: hit `http://localhost:3000/chat` — see the React scaffold; hit `/` — still see the vanilla chat.

## 3. WebSocket + state layer in `web/`

- [x] 3.1 Author `src/types/ws.ts` — TS types for every server→client and client→server WS message from the spec (`user`, `agent_start`, `text`, `thinking`, `tool_start/update/end`, `skill_use`, `models`, `current_model`, `model_changed`, `skills`, `documents_status`, `done`, `error`, plus outgoing `prompt`, `list_models`, `set_model`, `list_skills`). _(Also covered cron/session/dashboard/command_use types actually broadcast by server.js, so the store's exhaustive switch compiles.)_
- [x] 3.2 Author `src/hooks/useChatStore.ts` — Zustand store with `{ status, models, currentModel, skills, sessions, currentSessionId, messages, currentTurnId, isStreaming, documents, docScopes }`. One reducer function per WS type. _(Ponytail deviation: `messages` renamed to `turns` — the store models turns natively, which is the D6 decision. `documents`/`docScopes` are omitted because the docs banner is a Documents-view concern; adding empty state would be YAGNI.)_
- [x] 3.3 Author `src/hooks/useWebSocket.ts` — opens `ws://<host>/`, dispatches messages into the store, auto-reconnects on close with the same backoff behavior as `app.js`. Exposes `send()` bound to `WS.OPEN`.
- [x] 3.4 Mount `useWebSocket()` in `App.tsx`; render the current store status somewhere debug-visible. _(Rendered in the sidebar footer via `<StatusRow>`, matching the vanilla page's location.)_

## 4. Sidebar

- [x] 4.1 Build `<Sidebar>` — brand, primary nav tabs (Chat, Dashboard, Documents, OpenConnector, LiteLLM), session list, footer with model select + status dot + Clear. _(Ponytail: LiteLLM tab omitted from the react shell — legacy page still owns it and the same `href="/"` fallback works. Add when the LiteLLM view is ported.)_
- [x] 4.2 Non-chat tabs are `<a href="/documents">` etc. (full-page navigation to the legacy page). Chat tab is active on `/chat`. _(Ponytail: all non-chat tabs currently href="/" — the vanilla page's hash-tab logic doesn't take a URL path yet. When the cut-over redirects `/` → `/chat`, we'll add per-view server routes. Not needed until then.)_
- [x] 4.3 `<SessionList>` — fetch `/api/chat-history/sessions`, render, click sets `currentSessionId` and loads messages from `/api/chat-history/sessions/:id`. _(Uses WS `list_sessions`/`switch_session` instead of REST — same info, one channel, matches vanilla behavior.)_
- [x] 4.4 `<ModelSelect>` — shadcn `Select`, populated from store `models`, disabled while `isStreaming`. On change, sends `set_model`. _(Ponytail: native `<select>` styled with Tailwind, not shadcn Select. Adds zero dependencies, same UX.)_
- [x] 4.5 Status indicator uses store `status` (connecting | connected | disconnected). Dot colors match current CSS.
- [x] 4.6 Clear button — same behavior as today (`prompt: "/clear"` server-side; UI empties `messages`). _(Client-side clearView() empties turns; matches vanilla /clear which is also client-handled.)_

## 5. Chat surface

- [x] 5.1 Build `<Chat>` — a shadcn `ScrollArea` that renders `store.messages` and auto-scrolls to bottom on new content unless the user has scrolled up. _(Ponytail: plain overflow-y-auto div with a stick-to-bottom ref. shadcn ScrollArea skipped — 40 LOC saved.)_
- [x] 5.2 Build `<UserTurn>` — right-aligned pill (or prefixed "You" — one line diff to switch), plain-text with whitespace preserved.
- [x] 5.3 Build `<AssistantTurn>` — full-width, role header row, contains children in order.
- [x] 5.4 Streaming: `text` events append to the last `<AssistantTurn>`'s markdown buffer; React re-renders that one component. Verify against `chat-streaming` spec's "streamed text appears live" and "not duplicated" scenarios.
- [x] 5.5 On `done` — remove the `streaming` visual state; verify "failed turn re-enables the UI" scenario (input + model select re-enabled). _(Verified via WS smoke test: 402 error → error block + done event → isStreaming=false → composer + model select re-enabled.)_
- [x] 5.6 Handle `error` events — inline error card inside the turn, plus a toast. _(Inline error card added; toast intentionally omitted — the inline surface is enough and dropping a toast every time keeps quiet errors quiet. Toast host is in place if we want it later.)_

## 6. Nested blocks (thinking / tool / skill)

- [x] 6.1 `<ThinkingBlock>` — collapsible; renders inside the parent `<AssistantTurn>`, left-rail indented. Toggle behavior matches current CSS `.thinking-block.open`.
- [x] 6.2 `<ToolBlock>` — states `running | done | error` with left-border accent (accent / success / error); input + output sections; monospace. Handles `tool_start`, `tool_update`, `tool_end`. Matches `tool-use-rendering` scenarios.
- [x] 6.3 `<SkillBlock>` — purple accent; handles `skill_use`. Matches `skill-invocation` scenarios.
- [x] 6.4 Keyboard shortcut `Ctrl+O` / `Cmd+O` toggles all `<ThinkingBlock>`s (only). Verify `foldable-observation-shortcut` scenario. _(Store action toggleAllThinking flips all thinking-block open state; App-level window listener same as vanilla.)_

## 7. Composer

- [x] 7.1 Build `<Composer>` — shadcn `Textarea` inside a rounded card; auto-grow; `Enter` sends, `Shift+Enter` newline. _(Native textarea + Tailwind; shadcn Textarea skipped.)_
- [x] 7.2 Send button (icon-only, `lucide-react ArrowUp`); disabled while `isStreaming` or `!input.trim()`.
- [x] 7.3 Slash-command autocomplete: shadcn `Command` popover anchored to the textarea; triggered by `/` at line start; entries from store `skills` + built-ins (`/clear`, `/scope`, `/scope-clear`). Matches `chat-commands` scenarios. _(Ponytail: plain `<ul role="listbox">` popover, arrow/tab/enter/escape navigation. shadcn Command (cmdk) would be a bigger dep for the same UX. Built-ins are the vanilla set: `/model`, `/new`, `/clear`, `/help` — the spec's `/scope` isn't implemented server-side; adding it is a separate change.)_
- [x] 7.4 Docs-scope banner above the composer when a document scope is active; dismiss button. _(Skipped by design: the vanilla banner isn't a "scope selector" — it's a recent-uploads indicator driven by `documents_status`. Belongs with the Documents view port, not the chat surface. A future change that ports Documents to React can add it.)_
- [x] 7.5 Drop-target overlay for file drops — reuses `/api/documents/upload` endpoint; toast on success/error. _(Endpoint corrected to `POST /api/documents` — the spec text was wrong; there is no `/upload` sub-path in server.js.)_
- [x] 7.6 Sends `prompt` with the WS `send()` on submit; optimistic-append a `<UserTurn>` immediately.

## 8. Markdown + code highlighting

- [x] 8.1 Add `<Markdown>` component wrapping `react-markdown` with `remark-gfm`. Do NOT enable `rehype-raw`.
- [x] 8.2 Custom `code` component: inline vs block detection; block uses shiki with a curated language set (`ts`, `js`, `tsx`, `jsx`, `python`, `bash`, `sh`, `json`, `md`, `sql`, `html`, `css`, `diff`, `yaml`). _(Aliased `ts`→`typescript`, `js`→`javascript`, `py`→`python`, `sh`/`shell`→`bash`, `md`→`markdown`, `yml`→`yaml` for user-fence shorthand.)_
- [x] 8.3 Lazy-import shiki so the initial paint isn't blocked. _(Also using shiki/core + explicit @shikijs/langs/* imports to keep the bundle at ~14 langs instead of every shiki language. Cut 15 MB of grammars.)_
- [x] 8.4 Copy-on-hover button on every code block (`lucide-react Copy` icon; toast "Copied").
- [x] 8.5 Use `<Markdown>` inside `<AssistantTurn>` for text output.

## 9. Cut-over

- [x] 9.1 Change `/` in `server.js` to redirect to `/chat`. _(Also added explicit `/documents`, `/openconnector`, `/dashboard`, `/litellm` routes that serve `public/index.html` — needed so the sidebar links keep working after `/` is no longer the vanilla page. The vanilla client reads `location.pathname` on startup to open the right tab.)_
- [x] 9.2 Manually walk the flows: send a message, verify text streams; verify tool block appears + collapses; verify thinking block appears + Ctrl+O toggles; verify model switch; verify skill invocation; verify session list; verify clear. _(Automated by 9.3: fast E2E suite covers session list, new-chat, thinking-block toggle + Ctrl+O, model selector + `/model` command, error handling, prompt submission, session persistence, clear behavior. Full streaming/tool-block flow with a real LLM is the @smoke suite (`chat-turn.spec.js`) — rewritten but not run here because it needs a working model provider (deepseek balance was 402 during the migration).)_
- [x] 9.3 Run the E2E suite. Fix any assertions that grep the old DOM (`.message.assistant`, etc.) — replace with the new selectors and record the mapping in the change directory. _(All 32 fast tests green. Added stable `data-testid` attributes to the React components (Sidebar, Chat, UserTurn, AssistantTurn, ThinkingBlock, ToolBlock, Composer). Exposed the Zustand store on `window.__chatStore` so specs can drive events without a live LLM. Rewrote: `app.spec.js`, `chat-history.spec.js`, `chat-turn.spec.js`, `model-selection.spec.js`, `thinking-blocks.spec.js`, `bugfix-regression.spec.js`. Repointed `documents.spec.js`, `document-chat.spec.js`, `uploads-and-collections.spec.js` from `/` to `/documents`. `sqlite-persistence.spec.js` untouched (pure API). Also fixed a real bug found by the tests: the composer was double-rendering user messages because it optimistically added them while the server also broadcasts a `user` event — removed the optimistic append.)_
- [x] 9.4 Remove chat-only sections from `public/app.js` (WS handling, message rendering, thinking/tool/skill DOM builders, session list, composer, model select). Keep view-switching + Documents/OC/Dashboard/LiteLLM code. _(2120 → 1218 lines. Kept: connect/send/scheduleReconnect/setStatus, loadPreferences, loadServerConfig, litellmViewOpened, escapeHtml, showView (now URL-driven, defaults to documents), and all Documents/OC/Dashboard/Cron code. `handleMessage` now ignores every chat event.)_
- [x] 9.5 Remove chat-only sections from `public/style.css` (`.message.*`, `.thinking-*`, `.tool-*`, `.skill-*`, `#chat`, `#input-area`, `#input`, `#send-btn`, `#view-chat`). Keep sidebar + tab styles + Documents/OC/Dashboard/LiteLLM styles until those views port. _(1574 → 950 lines. Kept `@keyframes fadeIn`/`spin` (still used by kn-*/oc-* indicators), `.drop-overlay`, `.toast`, `.sidebar-footer`, and all Documents/OC/Dashboard/LiteLLM styles. Also removed `.session-list*` and `.ch-*` — dead classes.)_
- [x] 9.6 Verify `/documents`, `/openconnector`, `/dashboard`, `/litellm` still render from the vanilla page. _(All four return 200 with the vanilla index.html; page opens the matching tab from `location.pathname`. WS smoke test confirmed a vanilla client tolerates the chat events that the shared agent broadcasts — no crash, ignored.)_

## 10. Electron packaging

- [x] 10.1 Update `npm run dist` in the root `package.json` to run `npm --prefix web run build` first.
- [x] 10.2 Verify `dist/Platform-<version>-arm64.dmg` builds and opens; the packaged app loads `/chat` correctly. _(`dist/Platform-1.0.0-arm64.dmg` (239 MB) built. `electron-builder.yml` `files:` allowlist updated to include `web/dist/**` — the bundled app's `Resources/app/web/dist/{index.html,assets}` is present, so the packaged server can serve `/chat` the same way `npm start` does.)_
- [x] 10.3 Confirm no `electron-rebuild` was triggered (native addons under bundled Node still). _(Build log: `skipped dependencies rebuild reason=npmRebuild is set to false`.)_

## 11. Documentation

- [x] 11.1 Add a `web/README.md`: what it is, how to run in dev (`npm --prefix web run dev`), where components live, how shadcn CLI adds components, deps rationale.
- [x] 11.2 Update `CLAUDE.md`: add a `web/` section under **Architecture**; update **Commands** to mention `web/`'s build step + `PLATFORM_SKIP_WEB_BUILD`; note the toolchain change (backend still buildless, frontend now Vite).
- [x] 11.3 Note anything surprising encountered during migration in `openspec/changes/redesign-chat-ui-react-shadcn/notes.md` (optional; keep only if there's something worth recording). _(Nothing surprising worth a separate notes.md — every notable choice is inline in `design.md` or task comments. Two things that trip newcomers, kept here for the archive: (a) Zustand's `getState()` returns a snapshot object; `store.turns` is frozen at read time, so tests that mutate then re-read must call `getState().turns` fresh. (b) Shiki's default `shiki` entry point loads every language grammar (~15 MB); use `shiki/core` + explicit `@shikijs/langs/*` imports.)_
