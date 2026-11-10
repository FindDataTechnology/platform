# End-to-end tests (Playwright)

Browser-driven E2E tests that boot the real server and drive the vanilla-JS UI.

## Run

```bash
npm install
npx playwright install chromium   # one-time; see "Proxy" below if it fails
npm run test:e2e         # fast suite (offline, no LLM call)
npm run test:e2e:smoke   # only the @smoke chat-turn project (real LLM calls)
npm run test:e2e:live    # @live tests against the deployed service (opt-in)
```

## What it covers

- `app.spec.js` — app loads, sidebar navigation switches views.
- `documents.spec.js` — text and markdown upload → `ready`; view content; delete.
- `chat-history.spec.js` — new session appears as current; viewable read-only.
- `chat-turn.spec.js` (`@smoke`) — a real chat turn: assistant text rendered
  exactly once (no duplication) and persisted to chat history.

## How it works

`playwright.config.js` launches `node server.js` on port `3100` (override with
`E2E_PORT`) bound to `127.0.0.1`, using throwaway store directories under
`os.tmpdir()` (via the `CHAT_HISTORY_STORE_DIR` / `DOCUMENTS_STORE_DIR` env vars)
so your real `chat-history-store/` and `documents-store/` are never touched. The
server is shared across the suite (one agent session, matching production) and
tests run sequentially.

Tests are split across three Playwright projects: `fast` (offline,
deterministic — what `npm run test:e2e` and CI run), `smoke` (the `@smoke`
chat-turn specs that spend real LLM tokens — `npm run test:e2e:smoke` selects
ONLY this project), and `live` (tests against the deployed remote service,
reachable only via the explicit `test:e2e:live*` scripts). No script except
the `live` ones ever contacts the remote service.

## Proxy

If `npx playwright install chromium` is blocked, route it through the local
proxy:

```bash
HTTP_PROXY=http://127.0.0.1:7892 HTTPS_PROXY=http://127.0.0.1:7892 npx playwright install chromium
```
