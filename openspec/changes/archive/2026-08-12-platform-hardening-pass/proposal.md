## Why

An explore pass surfaced three classes of defect that are independent of the
open desktop-vs-platform direction question and should be fixed regardless:

1. **A concurrency race in the prompt path** — the `isStreaming` flag is set in
   the asynchronous `agent_start` event, not at prompt dispatch. Two prompts
   arriving within that window both take the non-`steer` path and start two
   turns on the single shared session. This is reproducible today with a single
   user and two browser tabs, before any multi-user scale-up.
2. **A real Volces API key baked into `server.js` as a fallback default** — it
   lives in git history and is bundled into every shipped `.dmg`/`.exe`, shared
   by all installs. One leak compromises the key for everyone.
3. **Hygiene gaps** — `DocumentsPage` ships with zero i18n despite a complete
   `documents.*` locale namespace already existing; three components subscribe
   to the entire documents store (re-rendering the doc tree on every query
   keystroke); `cron_remove/pause/resume/run` WS handlers lack the `try/catch`
   their siblings have; several async paths leak unhandled rejections (Express
   4 does not catch them); the WS client reconnects on a fixed 2s loop forever
   with no backoff and no `online` trigger.

## What Changes

### Cluster A — Safe mechanical (no behavior change)
- Wire `t()` into `DocumentsPage` and the `Composer` upload toasts; the locale
  keys already exist in all five bundles.
- Add `useShallow` slice selectors to the three `useDocumentsStore()` consumers
  so `docQuery` keystrokes no longer re-render the documents tree.
- Wrap `cron_remove` / `cron_pause` / `cron_resume` / `cron_run` WS handlers in
  `try/catch` (matching `cron_add`); add `.catch` to the connect-time
  `workdirStore.getWorkdir()` promise; wrap `shutdown()`'s `closeMcpClients`
  await; wrap `arrayBuffer()` reads in `createWebProxy` / `proxyLitellmUi`.
- Replace the WS client's fixed 2s reconnect with exponential backoff + jitter,
  a max-retry cap, and an `online` event trigger.

### Cluster B — Concurrency gate
- Set `isStreaming = true` **synchronously** at prompt dispatch (before the
  first `await session.prompt()`) on the non-`steer` path, so a concurrent
  second prompt reliably observes the in-flight turn and steers (the existing
  intended behavior) instead of racing a second turn.

### Cluster C — Remove baked-in API key (**BREAKING** vs. the current
`web-chat-server` spec, which mandates hard-fail without a key)
- Delete the `ark-...` fallback from `server.js:36`; read `VOLCES_API_KEY` as
  an optional, trimmed env var.
- Make the Volces chat provider optional (graceful degrade, mirroring LiteLLM):
  unset key → Volces provider not registered, server still starts. If neither
  LiteLLM nor Volces is configured, the server starts with no chat provider
  (chat non-functional, logged) rather than exiting.
- No code change to `electron/main.js`'s `sk-xxx-baked-fallback` placeholder —
  its comment ("use the baked fallback from server.js") becomes accurate once
  the real fallback is gone; the desktop app must provision a real key via
  `settings.json`.

## Capabilities

### New Capabilities
- _(none)_

### Modified Capabilities
- `chat-streaming`: the streaming guard is set synchronously so the existing
  `steer`-on-concurrent-prompt behavior is reliable (closes the race).
- `web-chat-server`: **REMOVES** the "server fails without API key" requirement;
  **ADDS** graceful-degradation when no chat provider is configured, no-secrets-
  in-source, and WS-error-surfacing (no unhandled rejections) requirements.
- `web-chat-ui`: the reconnect requirement changes from a fixed 2s retry to
  exponential backoff with jitter, a cap, and an `online` event trigger.
- `internationalization`: **ADDS** a requirement that all first-party pages use
  the translation bundle for user-visible strings (`DocumentsPage` compliance).

## Impact

- `server.js` — API-key line, provider factory guard, `extensionFactories`
  conditional, prompt-path `isStreaming` set, cron handler try/catch,
  `workdirStore`/`shutdown`/proxy async catches.
- `web/src/pages/DocumentsPage.tsx` — i18n wiring + `useShallow` selectors.
- `web/src/components/Composer.tsx` — upload-toast `t()` wiring.
- `web/src/hooks/useWebSocket.ts` — reconnect backoff + `online` trigger.
- `electron/main.js` — comment-only (the baked-fallback placeholder already
  uses `sk-xxx`).
- `openspec/specs/{chat-streaming,web-chat-server,web-chat-ui,internationalization}`
  — delta specs merged on archive.
- `.env` — operators relying on the baked key must set `VOLCES_API_KEY`
  explicitly (it is already set in the dev `.env`).
