## Why

Today the frontend is one 2,120-line `public/app.js` + 1,574-line `public/style.css` of vanilla ES modules that hand-build DOM. It works, but three things are hurting it visibly and structurally:

- **The chat surface reads as 2019-era.** Deep-navy palette, 85%-width blue/dark bubbles, no markdown or code highlighting (`el.textContent = text` — a returned Python function shows as one wrapping line), and tool/thinking blocks sit as siblings to the assistant bubble instead of nesting under the turn they belong to.
- **Every new UI feature has a high floor.** Slash-command autocomplete, model picker, tab switcher, modal dialogs, sidebars, dropdowns, tooltips, keyboard-driven command palette — each one is a hand-rolled DOM builder living somewhere in `app.js`. There is no component boundary, no accessibility scaffolding, and no theme system.
- **Reference-tier polish is out of reach.** The projects users compare us to (Vercel AI Chatbot, Claude.ai, ChatGPT, Cline, Open WebUI) are all built on shadcn-class primitives on top of Radix — a ceiling we cannot reach by hand-crafting vanilla DOM.

We are going to introduce a React + shadcn/ui + Tailwind + Vite frontend under a new `web/` workspace, and switch `server.js` to serve its build output — starting with the **chat view only**. Other views (Documents, OpenConnector, Dashboard, LiteLLM) stay on the vanilla page until follow-up changes port them. The WebSocket and REST contracts do not change.

## What Changes

- Add `web/` — a Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui workspace. Frontend-only; the server, MCP bridge, documents, chat history, and OpenConnector modules are untouched.
- Port the **chat view** to React: sidebar (brand, tabs, session list, model select, status, clear), chat log (messages, streamed assistant bubbles, thinking/tool/skill collapsibles, docs-scope banner), composer (textarea, send, autocomplete popup, drop-target). Render assistant text through markdown + syntax highlighting.
- Introduce a component vocabulary based on shadcn primitives (`Button`, `ScrollArea`, `Command`, `Select`, `Tooltip`, `Sheet`, `Dialog`, `Toast`) — used only in the chat view initially; available for later views.
- Nest tool/thinking/skill blocks under the assistant turn that produced them (visual left-rail indent), instead of appending them as top-level siblings.
- Server: `server.js` serves `web/dist/` for the chat route and static assets, and continues to serve the legacy `public/` for the other views until they are ported. The WebSocket protocol at `/` is unchanged.
- Build wiring: `npm install` runs `web/`'s install too via a postinstall hook; `npm run build` produces `web/dist`; `npm start` continues to work in dev by serving the built dist (or Vite's dev-mode fallback proxy — one flag).
- Electron packaging: `npm run dist` runs `web build` before `electron-builder` — one extra step, no code change to the supervisor.

**Explicitly out of scope for this change (deferred to follow-ups):**
- Porting Documents, OpenConnector, Dashboard, LiteLLM views to React.
- Changing the WebSocket protocol or any REST endpoints.
- Adding artifacts, right-click menus, or command palette features (unlocked, not shipped).
- Light-mode theme (dark-only ships first; theme tokens are in place).
- E2E test updates beyond keeping the current smoke tests green.

## Capabilities

### New Capabilities
- `chat-ui-shell`: the React frontend shell — module structure, build outputs, static-serving contract, and the boundary of what the SPA owns versus what the server serves. Establishes the toolchain and how future views migrate in.

### Modified Capabilities
<!-- Existing frontend behavioral specs (chat-streaming, tool-use-rendering, model-selection, skill-invocation, chat-commands, foldable-observation-shortcut, app-navigation) describe user-observable behavior over the WS protocol. That behavior is preserved verbatim by the React port; no requirement text needs to change. If a scenario turns out to be UI-implementation-coupled during apply, we add a delta in a follow-up. -->
- _(none)_

## Impact

- **New files**: `web/` workspace — `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `index.html`, `src/**` (App, hooks, components, styles); `components.json` (shadcn CLI config); `web/dist/**` (build output, gitignored).
- **Modified**: `server.js` (static-serving root switch for the chat route, dev-mode Vite proxy option), root `package.json` (postinstall + build + start-electron scripts pick up `web/`), `.gitignore` (add `web/dist`, `web/node_modules`), `CLAUDE.md` (add the `web/` architecture entry + updated commands).
- **Deleted (at the end of this change)**: the chat sections of `public/app.js` and `public/style.css` — everything only used by the chat view. Documents/OpenConnector/Dashboard/LiteLLM code in `public/` stays until their own changes port them.
- **Dependencies added (in `web/`)**: `react`, `react-dom`, `typescript`, `vite`, `@vitejs/plugin-react`, `tailwindcss` v4, `@tailwindcss/vite`, `shadcn` CLI (dev), `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `zustand`, `react-markdown`, `remark-gfm`, `shiki`. No new runtime dependencies in the root `package.json`.
- **Toolchain**: Node build step introduced. The project's stated "no-build" stance changes for the frontend only. Backend remains buildless ESM.
- **Electron**: `npm run dist` calls `npm --prefix web run build` first. The supervisor does not change.
- **Reversibility**: this change is contained under `web/` and one small `server.js` diff. Reverting means deleting `web/`, restoring the `server.js` static root, and un-deleting the chat portions of `public/`. Kept easy on purpose.
