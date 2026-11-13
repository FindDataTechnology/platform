## Context

The CI/CD pipeline is complete: push → `docker-deploy.yml` builds the full-stack image (server.js + LiteLLM + OpenConnector + Postgres bundled) → pushes to Harbor → commit-backs the `sha-<short>` tag into `k8s/deployment.yaml` → ArgoCD auto-syncs → k3s rolls out → live at `http://23.144.68.246:30950`. The existing Playwright suite (`e2e/`, `playwright.config.js`) is solid but **local-only**: its `webServer` block spawns `node server.js` on port 3100 with throwaway temp store dirs, and its `fast`/`smoke` projects both depend on that locally-launched server. There is no Playwright path that points at the *deployed* NodePort, and no single command to run one — so verifying a deploy means manually opening the URL and clicking around.

Key constraint: the deployed service is a **stateful singleton** (1 replica, `Recreate` strategy, one RWO PVC at `/data` holding SQLite + chat-history + postgres-data + litellm.yaml). Tests against it must not pollute that state, and must not spend LLM tokens unless explicitly asked.

## Goals / Non-Goals

**Goals:**
- Catch deploy breakage (bad image tag, sidecar spawn failure, probe/NodePort misconfig, missing `harbor-pull` secret, broken SPA build) with one command, without a human opening a browser.
- Make live testing a repeatable, low-friction workflow: `make test-live` (or `npm run test:e2e:live`).
- Reuse the existing Playwright + Chromium install and the existing `e2e/helpers.js` navigation helpers — no new deps, no second test framework.
- Keep the local `fast`/`smoke` suites and their `webServer` config **completely untouched**.

**Non-Goals:**
- Replacing the local suite. Local tests remain the fast inner loop; live tests are the deploy-verification outer loop.
- Load/stress testing the deployed service.
- Testing from GitHub Actions runners. The NodePort is on a private IP reachable from the dev machine / a self-hosted runner, not from `ubuntu-latest`. Live tests are a manual or self-hosted-runner concern, documented as such.
- Asserting embedded third-party UI *content* (OpenConnector/LiteLLM iframe interiors). We assert the iframe mounts with the right same-origin `src`, not what the third-party app renders inside it.
- Mutating deployed state (uploading documents, creating collections, switching models persistently) in the default path.

## Decisions

### Decision 1: A separate `live` Playwright project, not an env flag on `fast`/`smoke`

**Choice:** Add a third project `live` to `playwright.config.js` (alongside `fast` and `smoke`) that greps `@live` / `@live-smoke`, resolves `baseURL` from `LIVE_SERVICE_URL` (default `http://23.144.68.246:30950`), and has **no `webServer` block**.

**Why over alternatives:**
- *Alternative A — a `LIVE_SERVICE_URL` env flag on the existing `fast` project:* rejected because `fast`'s `webServer` would still try to spawn `node server.js` on 3100 (and `reuseExistingServer: false` means it fails if :3100 is free-ish but the flag says "use the live URL"). Untangling the `webServer`-vs-external-URL logic inside one project is messier than a clean project split and risks breaking the local suite.
- *Alternative B — a separate config file (`playwright.live.config.js`):* rejected because it duplicates the `testDir`/`workers`/`globalTeardown`/project boilerplate and drifts from the main config. A third project in one config file is the single source of truth.

The `live` project sets `use: { baseURL: process.env.LIVE_SERVICE_URL || "http://23.144.68.246:30950" }` and omits `webServer` entirely, so Playwright connects to the already-running external URL and never tries to boot a local server.

### Decision 2: Read-only by default; LLM round-trip opt-in via `LIVE_SMOKE=1`

**Choice:** The default `@live` tests assert only observable, side-effect-free behavior: `/api/config` responds 2xx; `/` serves the SPA and routes to `/chat`; the sidebar + composer + status render; the WS connects (`status-text` becomes "Connected"); the OpenConnector/LiteLLM nav entries exist and their iframe elements mount with the expected same-origin `src`. None of these write to the PVC or call the LLM.

A single `@live-smoke` chat-turn test sends one real prompt and asserts the assistant bubble renders non-empty text. It is gated: `test.skip(!process.env.LIVE_SMOKE, "set LIVE_SMOKE=1 to spend an LLM token")`.

**Why:** The deployed PVC is shared production state. A default test run that wrote chat history or spent tokens on every deploy would pollute state and cost money. The read-only path catches the deploy-breakage failure modes (image/sidecar/probe/NodePort/secret/SPA-build) without those costs; the LLM round-trip is the one extra check that proves the *whole* stack (server → LiteLLM → Volces) is wired, available on demand.

### Decision 3: Reuse `e2e/helpers.js`, add a thin `e2e/live-helpers.js`

**Choice:** `gotoChat`, `pinLocaleEn` from `e2e/helpers.js` work against any origin (they navigate relative paths and set `localStorage`). Reuse them directly. Add `e2e/live-helpers.js` with two things: (1) `liveServiceUrl()` — resolves + asserts `LIVE_SERVICE_URL` so a misconfigured run fails fast with a clear message rather than a connection-timeout stack; (2) `skipUnlessLiveSmoke()` — the `LIVE_SMOKE` gate used by the `@live-smoke` test.

**Why not extend `helpers.js` itself:** `helpers.js`'s `prepareTempStoreDirs`/`cleanupTempStoreDirs` are local-suite concerns; mixing live-only helpers in would muddy the contract. A thin sibling file keeps the local helpers pure.

### Decision 4: Convenience commands — npm scripts + Makefile targets

**Choice:**
- `package.json`: `test:e2e:live` = `playwright test --project=live`, `test:e2e:live:smoke` = `LIVE_SMOKE=1 playwright test --project=live`.
- `Makefile`: `test-live` (default `LIVE_SERVICE_URL=http://23.144.68.246:30950`) and `test-live-smoke` (`LIVE_SMOKE=1`).

**Why both:** `npm run` is the cross-platform entry point (works on any machine that checked out the repo); the Makefile target bakes in the cluster's default URL so the common case is zero-arg. They call the same Playwright project.

### Decision 5: Assert iframe *mount*, not iframe *content*

**Choice:** For the OpenConnector and LiteLLM panels, assert the `<iframe>` element is present with `src` pointing at the same-origin proxy path (`/oc-web`, `/litellm-web`) — not the rendered content inside it.

**Why:** The iframe content is a third-party app served through a token-injecting reverse proxy; it can take variable time to load and its content is outside our contract. "The proxy route mounted an iframe" is the deploy-relevant assertion (the route exists, the SPA wired it up); "the third-party app rendered" is not our bug to catch here.

## Risks / Trade-offs

- **[Risk] The live smoke test writes chat history to the shared PVC.** → Mitigation: gated behind `LIVE_SMOKE=1` (never runs by default), documented as a state-polluting check, and the chat-history session it creates is harmless (read-only viewer can ignore it). Acceptable for a manual/on-demand smoke.
- **[Risk] NodePort 30950 unreachable from the run environment (e.g., a CI runner off the LAN).** → Mitigation: `live-helpers.js` fails fast with a clear "cannot reach LIVE_SERVICE_URL" message; the workflow is documented as a dev-machine / self-hosted-runner concern, not a `ubuntu-latest` CI step. No live test runs in `docker-deploy.yml`.
- **[Risk] A deploy mid-rollout leaves the pod briefly unavailable → flaky live test.** → Mitigation: the readiness probe already gates traffic; the read-only tests use Playwright's default navigation timeout (60s) which absorbs a slow rollout. The smoke test retries the prompt send on transient WS disconnect.
- **[Risk] Asserting `status-text` = "Connected" couples the live test to the WS client's ready state string.** → Mitigation: that string is already the contract the local suite asserts (`gotoChat`), so the live suite reuses the same contract — no new coupling introduced.
- **[Trade-off] Two test surfaces (local `fast`/`smoke` + live `@live`) to maintain.** → Accepted: they cover different failure modes (code regressions vs. deploy breakage) and share helpers, so the marginal cost is low.

## Migration Plan

No migration — purely additive. No backend code changes, no changes to the local suites or their `webServer`. Rollout:

1. Add `e2e/live-helpers.js` + `e2e/live.spec.js` (+ the `@live-smoke` test).
2. Add the `live` project to `playwright.config.js`.
3. Add `test:e2e:live` / `test:e2e:live:smoke` to `package.json`.
4. Add `test-live` / `test-live-smoke` to the `Makefile`.
5. Document in `DEPLOY.md`.

Rollback: delete the `live` project + the two files + the two scripts/targets. Nothing else depends on them.

## Open Questions

- None blocking. The default `LIVE_SERVICE_URL` is the known NodePort; `LIVE_SMOKE` default is off. Both overridable.
