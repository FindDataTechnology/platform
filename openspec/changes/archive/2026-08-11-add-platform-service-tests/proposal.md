## Why

The service is now deployed end-to-end (CI builds the full-stack image → Harbor → ArgoCD → k3s NodePort 30950, live at `http://23.144.68.246:30950`), but the existing Playwright suite only exercises the **local** `node server.js` on port 3100 with throwaway store dirs. Nothing verifies that the *deployed* container — where the supervisor spawns LiteLLM + OpenConnector + Postgres as real localhost children inside one pod — actually serves a working app. A deploy can land broken (bad image tag, sidecar spawn failure, probe/NodePort misconfig, missing `harbor-pull` secret) and go undetected until a human opens the URL. Worse, there is no single convenient command to run tests against the live service, so checking is ad-hoc and easy to skip.

## What Changes

- Add a **live-service test capability**: Playwright tests that target the deployed NodePort URL (default `http://23.144.68.246:30950`, overridable via `LIVE_SERVICE_URL`), distinct from the local suite. These tests are **read-only** — they assert the deployed app boots, routes resolve, the WebSocket connects, the SPA renders its shell + nav, the embedded panels (OpenConnector / LiteLLM) mount their same-origin iframes, and `/api/config` responds — without writing chat history, uploading documents, or spending LLM tokens.
- Add a separate Playwright **`live` project** (alongside the existing `fast` / `smoke` projects) so it never launches a `webServer`, never creates temp store dirs, and never disturbs the local suite. It connects to an already-running external URL.
- Add an opt-in **`@live-smoke`** chat-turn test that sends one real prompt against the deployed service (gated behind the `live` project + a `LIVE_SMOKE=1` flag) so a full end-to-end LLM round-trip can be verified on demand.
- Add convenience entry points: `npm run test:e2e:live` and a `make test-live` Makefile target, plus a `make test-live-smoke` for the LLM round-trip variant.
- Document the workflow in `DEPLOY.md` (how to run, what `LIVE_SERVICE_URL` overrides, what the read-only tests check, when to run the smoke variant).

No backend code changes. No changes to the local `fast`/`smoke` suites or their `webServer` config.

## Capabilities

### New Capabilities
- `live-service-testing`: Read-only Playwright coverage against the *deployed* service (k3s NodePort), plus the convenience commands (`npm run test:e2e:live`, `make test-live`) and the opt-in live chat-turn smoke test.

### Modified Capabilities
<!-- None. The existing `e2e-testing` capability's requirements (local server launch, temp-store isolation, the fast/smoke projects, `npm run test:e2e` / `test:e2e:smoke`) are unchanged. The live suite is a separate contract that reuses helpers, not a modification. -->

## Impact

- **`playwright.config.js`** — add a `live` project (grep `@live` / `@live-smoke`), with `baseURL` resolved from `LIVE_SERVICE_URL` env (default the deployed NodePort); no `webServer` block for this project.
- **`e2e/`** — new `live.spec.js` (read-only checks) and, behind `@live-smoke`, a live chat-turn test; reuse existing helpers (`gotoChat`, `pinLocaleEn`) where the deployed URL is reachable. A small `live-helpers.js` may factor out the `LIVE_SERVICE_URL` resolution + the "skip unless this is the live project" guard.
- **`package.json`** — add `test:e2e:live` and `test:e2e:live:smoke` scripts.
- **`Makefile`** — add `test-live` and `test-live-smoke` targets (default `LIVE_SERVICE_URL=http://23.144.68.246:30950`).
- **`DEPLOY.md`** — new section: running live tests, overriding the URL, what the read-only checks assert, when to use the smoke variant.
- **No runtime/dependency changes** — reuses the existing Playwright + Chromium install; no new npm deps.
