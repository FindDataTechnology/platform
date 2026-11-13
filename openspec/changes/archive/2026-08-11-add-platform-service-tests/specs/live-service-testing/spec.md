## ADDED Requirements

### Requirement: A live test project targets the deployed service without launching a local server
The project SHALL provide a Playwright `live` project (alongside the existing `fast` and `smoke` projects) that connects to an already-running external service URL resolved from the `LIVE_SERVICE_URL` env var (default `http://23.144.68.246:30950`), and SHALL NOT define a `webServer` block for this project. The `live` project SHALL select only tests tagged `@live` and `@live-smoke`. It SHALL NOT create temp store directories, SHALL NOT set `CHAT_HISTORY_STORE_DIR` / `DOCUMENTS_STORE_DIR` / `SESSIONS_STORE_DIR` / `DB_PATH`, and SHALL NOT spawn `node server.js`.

#### Scenario: live project connects to the deployed URL
- **WHEN** a developer runs the `live` Playwright project with `LIVE_SERVICE_URL` set to the deployed NodePort
- **THEN** Playwright SHALL connect to that URL as the base URL
- **AND** SHALL NOT attempt to launch a local server

#### Scenario: live project defaults to the known NodePort
- **WHEN** the `live` project runs without `LIVE_SERVICE_URL` set
- **THEN** the base URL SHALL default to `http://23.144.68.246:30950`

#### Scenario: unreachable service URL fails fast
- **WHEN** `LIVE_SERVICE_URL` is set to a URL no route can reach
- **THEN** the test SHALL fail with a message naming the unreachable URL
- **AND** SHALL NOT retry silently beyond Playwright's navigation timeout

### Requirement: Default live tests are read-only and spend no LLM tokens
The default `@live` tests SHALL only assert observable, side-effect-free behavior of the deployed service: the `/api/config` endpoint responds; the SPA serves at `/` and routes to `/chat`; the sidebar, composer, and status elements render; the WebSocket connects (status becomes "Connected"); and the embedded panel iframes mount with their expected same-origin proxy `src`. The default `@live` tests SHALL NOT submit a chat prompt, SHALL NOT upload documents, SHALL NOT create collections, and SHALL NOT switch models.

#### Scenario: /api/config responds on the deployed service
- **WHEN** the test requests `/api/config` against the deployed service
- **THEN** the response SHALL have a 2xx status

#### Scenario: SPA root routes to chat
- **WHEN** the test navigates to `/` on the deployed service
- **THEN** the SPA SHALL route to `/chat`
- **AND** the sidebar, composer, and status elements SHALL be visible

#### Scenario: WebSocket connects on the deployed service
- **WHEN** the test loads `/chat` on the deployed service
- **THEN** the status element SHALL become "Connected"

#### Scenario: embedded panel iframes mount
- **WHEN** the test navigates to the OpenConnector and LiteLLM panel routes on the deployed service
- **THEN** an iframe element SHALL be present for each
- **AND** each iframe's `src` SHALL point at the same-origin proxy path (`/oc-web` or `/litellm-web`)

#### Scenario: default live tests do not mutate deployed state
- **WHEN** the default `@live` suite runs against the deployed service
- **THEN** no chat prompt SHALL be submitted
- **AND** no document SHALL be uploaded
- **AND** no LLM token SHALL be spent

### Requirement: An opt-in live chat-turn smoke test verifies the full LLM round-trip
The suite SHALL include a `@live-smoke` test, selected by the `live` project, that sends one real chat prompt against the deployed service and asserts the assistant bubble renders non-empty text. This test SHALL be skipped unless the `LIVE_SMOKE` env var is set to a truthy value, so it never runs by default and never spends an LLM token without explicit opt-in.

#### Scenario: live smoke test is skipped by default
- **WHEN** the `live` project runs without `LIVE_SMOKE` set
- **THEN** the `@live-smoke` test SHALL be skipped
- **AND** no LLM token SHALL be spent

#### Scenario: live smoke test sends a prompt and asserts a reply
- **WHEN** the `live` project runs with `LIVE_SMOKE=1`
- **THEN** the test SHALL send one prompt through the deployed service
- **AND** SHALL assert the assistant bubble renders non-empty text

### Requirement: Convenience commands run the live suite
The project SHALL provide an `npm run test:e2e:live` script that runs the `live` Playwright project, an `npm run test:e2e:live:smoke` script that runs it with `LIVE_SMOKE=1`, a `make test-live` Makefile target (defaulting `LIVE_SERVICE_URL` to the deployed NodePort), and a `make test-live-smoke` target that sets `LIVE_SMOKE=1`.

#### Scenario: run the read-only live suite via npm
- **WHEN** a developer runs `npm run test:e2e:live`
- **THEN** the `live` Playwright project SHALL run against the deployed service
- **AND** the `@live-smoke` test SHALL be skipped

#### Scenario: run the live smoke suite via npm
- **WHEN** a developer runs `npm run test:e2e:live:smoke`
- **THEN** the `live` project SHALL run with `LIVE_SMOKE=1`
- **AND** the `@live-smoke` test SHALL execute

#### Scenario: run the read-only live suite via make
- **WHEN** a developer runs `make test-live`
- **THEN** `LIVE_SERVICE_URL` SHALL default to `http://23.144.68.246:30950`
- **AND** the `live` Playwright project SHALL run

#### Scenario: run the live smoke suite via make
- **WHEN** a developer runs `make test-live-smoke`
- **THEN** `LIVE_SMOKE=1` SHALL be set
- **AND** the `@live-smoke` test SHALL execute

### Requirement: Live testing workflow is documented
The `DEPLOY.md` file SHALL document the live test workflow: the `make test-live` / `npm run test:e2e:live` commands; how to override `LIVE_SERVICE_URL`; what the read-only `@live` tests assert; that the `@live-smoke` variant spends an LLM token and writes a chat session to the deployed PVC and is gated behind `LIVE_SMOKE=1`; and that live tests are a dev-machine / self-hosted-runner concern (not run from `ubuntu-latest` CI, since the NodePort is not reachable from there).

#### Scenario: deploy docs describe the live test commands
- **WHEN** a developer reads `DEPLOY.md`
- **THEN** the `make test-live` and `npm run test:e2e:live` commands SHALL be documented
- **AND** the `LIVE_SERVICE_URL` override SHALL be documented

#### Scenario: deploy docs warn about the smoke variant's cost
- **WHEN** a developer reads the live-testing section of `DEPLOY.md`
- **THEN** it SHALL state that `@live-smoke` spends an LLM token and writes to the deployed PVC
- **AND** SHALL state that it is gated behind `LIVE_SMOKE=1`
