## 1. Playwright config - `live` project

- [x] 1.1 Add a `live` project to `playwright.config.js` (alongside `fast`/`smoke`) that selects tests tagged `@live`/`@live-smoke`, resolves `baseURL` from `LIVE_SERVICE_URL` env (default `http://23.144.68.246:30950`), and has **no** `webServer` block - it connects to an already-running external URL.
- [x] 1.2 Ensure the `live` project overrides the root `webServer` (which spawns local `node server.js`) so launching the live suite never starts a local server and never creates temp store dirs. Verify `use: { baseURL }` is per-project, not inherited from a project that still binds a webServer.
- [x] 1.3 Confirm `workers: 1` / `fullyParallel: false` still apply to the live project (sequential, avoids hammering the single shared agent session on the deployed pod).

## 2. Live test helpers

- [x] 2.1 Create `e2e/live-helpers.js`: resolve `LIVE_SERVICE_URL` (default `http://23.144.68.246:30950`), export `liveBaseURL` for the project config, and a `skipUnlessLive(test)` / per-test guard that skips `@live` tests when the active project is not `live` (so `npm run test:e2e` / `test:e2e:smoke` never accidentally run them).
- [x] 2.2 Reuse existing `gotoChat` / `pinLocaleEn` from `e2e/helpers.js` against the deployed URL - verify they work when `baseURL` is the NodePort (they use relative paths + `127.0.0.1` only in the local suite's `baseURL`, so no change needed, but confirm the `status-text` "Connected" wait tolerates the remote WS handshake latency - raise timeout if needed).

## 3. Read-only live spec (`@live`)

- [x] 3.1 Create `e2e/live.spec.js` tagged `@live` with read-only checks against the deployed service: `/api/config` responds 2xx with JSON; root `/` serves the SPA and routes to `/chat`; the shell renders `sidebar` + `composer-input` + `session-list-section` + `status-text` == "Connected" (WebSocket connects to the remote pod).
- [x] 3.2 Add nav assertions: the sidebar shows `nav-chat`, `nav-dashboard`, `nav-documents`, `nav-openconnector`, `nav-litellm`.
- [x] 3.3 Add deep-link checks: `/dashboard` resolves via SPA fallback and renders `dashboard-page`.
- [x] 3.4 Add embedded-panel mount checks: the OpenConnector (`/openconnector`) and LiteLLM (`/litellm`) routes mount their same-origin iframe containers (assert the iframe element is present; do **not** assert third-party UI content - those are external services that may be down).
- [x] 3.5 Add a WebSocket round-trip assertion: send a `list_models` (or `list_skills`) WS message and assert a `models`/`skills` response arrives - proves the deployed agent session is live, read-only, no tokens spent.

## 4. Live chat-turn smoke spec (`@live-smoke`, opt-in)

- [x] 4.1 Add a `@live-smoke` test (in `live.spec.js` or a sibling `live-smoke.spec.js`) that sends one real prompt to the deployed service and asserts a non-empty assistant text response. Gate it so it runs **only** when `LIVE_SMOKE=1` is set (skip otherwise), so `npm run test:e2e:live` (read-only) never spends LLM tokens.
- [x] 4.2 Assert the deployed chat-turn persists to the live chat-history store (via `/api/chat-history/sessions` listing) - read-only verification, no mutation beyond the one smoke prompt. Skip cleanly when `LIVE_SMOKE` unset.

## 5. Convenience entry points

- [x] 5.1 Add `test:e2e:live` script to `package.json` -> `playwright test --project=live` (read-only `@live` tests only).
- [x] 5.2 Add `test:e2e:live:smoke` script to `package.json` -> `LIVE_SMOKE=1 playwright test --project=live` (includes the `@live-smoke` chat-turn).
- [x] 5.3 Add `test-live` Makefile target: runs `npm run test:e2e:live` with `LIVE_SERVICE_URL` defaulting to `http://23.144.68.246:30950` (overridable inline: `make test-live LIVE_SERVICE_URL=...`).
- [x] 5.4 Add `test-live-smoke` Makefile target: runs `npm run test:e2e:live:smoke` with the same default URL.

## 6. Docs

- [x] 6.1 Add a "Live service testing" section to `DEPLOY.md`: what the read-only suite checks, how to run (`make test-live` / `npm run test:e2e:live`), how to override the URL, when/why to run the smoke variant (`make test-live-smoke`, `LIVE_SMOKE=1`), and the note that read-only tests never write chat history / upload documents / spend LLM tokens.

## 7. Verify

- [x] 7.1 Run `npm run test:e2e:live` against the live service at `http://23.144.68.246:30950` and confirm all `@live` read-only tests pass.
- [x] 7.2 Run `npm run test:e2e` (local fast suite) and confirm the new `live` project / `@live` tests do **not** run (no local server launch, no temp dirs created, no interference with the existing fast/smoke suites).
- [ ] 7.3 (Optional, on demand) Run `make test-live-smoke` and confirm one real LLM round-trip against the deployed service succeeds.
