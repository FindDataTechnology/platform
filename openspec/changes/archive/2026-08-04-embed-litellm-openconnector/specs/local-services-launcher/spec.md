## ADDED Requirements

### Requirement: Headless launcher entry point
The system SHALL provide a headless (non-Electron) process supervisor invoked by `npm start` that orchestrates the bundled LiteLLM, bundled OpenConnector, and `server.js` as child processes using the same shared primitives as the desktop supervisor. The launcher SHALL open no application window. When bundled LiteLLM and OpenConnector resources are both absent AND no external base URL is set for either service, the launcher SHALL still spawn `server.js` under the supervisor, producing behavior observably equivalent to running `node server.js` directly.

#### Scenario: npm start brings up local services and server.js
- **WHEN** a developer runs `npm start` with bundled LiteLLM and OpenConnector resources present and no external URLs set
- **THEN** the launcher spawns LiteLLM, OpenConnector, and `server.js` as supervised child processes
- **AND** opens no window
- **AND** stays alive to supervise them until interrupted

#### Scenario: launcher degenerates to server.js-only
- **WHEN** `npm start` runs with no bundled resources present and no external URLs set
- **THEN** the launcher spawns only `server.js` under the supervisor
- **AND** logs a warning that bundled LiteLLM/OpenConnector are absent
- **AND** `server.js` starts with neither LiteLLM nor OpenConnector enabled, as it does today

#### Scenario: launcher shuts down cleanly on interrupt
- **WHEN** the launcher receives SIGINT or SIGTERM
- **THEN** it runs ordered shutdown of all spawned children in reverse startup order
- **AND** does not trigger restart-on-crash logic for the shutdown

### Requirement: Local spawn with per-service external-URL override
For each of LiteLLM and OpenConnector independently, the launcher SHALL spawn the bundled service locally when its bundled resources are present on disk AND its `*_BASE_URL` is either unset OR a localhost URL (`localhost` / `127.0.0.1` / `::1`). When the `*_BASE_URL` is a localhost URL with an explicit port, the launcher SHALL spawn the service on that port; when unset, on a free localhost port. When the `*_BASE_URL` is a non-localhost (external) URL, the launcher SHALL NOT spawn that service and SHALL pass the URL through to `server.js` unchanged. The bundled-vs-external resolution SHALL reuse the desktop supervisor's descriptor resolution.

#### Scenario: localhost URL spawns the bundled service on that port
- **WHEN** bundled LiteLLM resources are present and `LITELLM_BASE_URL=http://localhost:4000`
- **THEN** the launcher spawns the bundled LiteLLM on port 4000
- **AND** injects `LITELLM_BASE_URL=http://localhost:4000` into `server.js`'s env
- **AND** does not contact any remote server

#### Scenario: both services spawned locally
- **WHEN** bundled LiteLLM and OpenConnector resources are present and neither `LITELLM_BASE_URL` nor `OPENCONNECTOR_BASE_URL` is set
- **THEN** the launcher spawns both services on distinct free localhost ports
- **AND** does not contact any remote server for either service

#### Scenario: external URL wins for one service
- **WHEN** bundled resources for both services are present
- **AND** `LITELLM_BASE_URL=https://litellm.example.com` is set but `OPENCONNECTOR_BASE_URL` is unset
- **THEN** the launcher spawns OpenConnector locally and does NOT spawn LiteLLM
- **AND** injects the external LiteLLM URL into `server.js`'s env unchanged

#### Scenario: external URL wins for both services
- **WHEN** both `LITELLM_BASE_URL` and `OPENCONNECTOR_BASE_URL` are set to external (non-localhost) URLs
- **THEN** the launcher spawns neither service locally
- **AND** health-checks each external URL without spawning a process, as the desktop supervisor does today

### Requirement: Resolved localhost URLs injected into server.js
The launcher SHALL inject the resolved localhost base URLs (`LITELLM_BASE_URL`, `OPENCONNECTOR_BASE_URL`) and the corresponding service credentials into `server.js`'s environment so that `server.js`, `open-connector.js`, `litellm-models.js`, and `mcp-bridge.js` discover the bundled services identically to external ones, with no code change in those modules.

#### Scenario: server.js receives local LiteLLM URL and key
- **WHEN** bundled LiteLLM is spawned on port Y and no external URL is set
- **THEN** `server.js` starts with `LITELLM_BASE_URL=http://127.0.0.1:Y` and a `LITELLM_API_KEY` in its environment
- **AND** the `pi-provider-litellm` extension and `/v1/models` discovery use that localhost URL

#### Scenario: server.js receives local OpenConnector URL and tokens
- **WHEN** bundled OpenConnector is spawned on port X and no external URL is set
- **THEN** `server.js` starts with `OPENCONNECTOR_BASE_URL=http://127.0.0.1:X` and runtime/admin tokens in its environment
- **AND** the OpenConnector panel, MCP registration, and `/oc-web` proxy use that localhost URL

### Requirement: Dev first-run seeding of config and credentials
The launcher SHALL perform an idempotent first-run seeding step before starting the supervisor when bundled resources are present: it SHALL copy `resources/litellm/default-config.yaml` to `<dataDir>/litellm.yaml` atomically (temp file + rename) when that file does not exist, and SHALL generate the service credentials the bundled processes require (`LITELLM_API_KEY` as `sk-` + 32-byte hex, `OPENCONNECTOR_RUNTIME_TOKEN` and `OPENCONNECTOR_ADMIN_TOKEN` as 32-byte hex) when each is absent, persisting them atomically to a dev settings file under `PLATFORM_DATA_DIR`. Existing files and credentials MUST NOT be overwritten. The seeding logic SHALL be the same Electron-agnostic implementation the packaged first-run bootstrap uses.

#### Scenario: fresh dev run seeds litellm.yaml and credentials
- **WHEN** the launcher starts with bundled resources present and no `litellm.yaml` or dev settings file in the data dir
- **THEN** it writes `<dataDir>/litellm.yaml` from the bundled default config atomically
- **AND** generates and persists `LITELLM_API_KEY`, `OPENCONNECTOR_RUNTIME_TOKEN`, and `OPENCONNECTOR_ADMIN_TOKEN` to the dev settings file
- **AND** injects them into the spawned children's environments

#### Scenario: second dev run preserves existing config and credentials
- **WHEN** the launcher starts and `litellm.yaml` and the dev settings file already exist
- **THEN** it does NOT overwrite `litellm.yaml`
- **AND** does NOT regenerate existing credentials
- **AND** completes seeding without error

#### Scenario: dev credentials never reach the browser
- **WHEN** the browser or any renderer requests configuration via WS or HTTP
- **THEN** the response MUST NOT include `LITELLM_API_KEY`, `OPENCONNECTOR_RUNTIME_TOKEN`, or `OPENCONNECTOR_ADMIN_TOKEN`

### Requirement: Lifecycle parity with the desktop supervisor
The launcher SHALL provide ordered startup with dependency readiness, HTTP health checking per transport, automatic restart on unexpected failure with backoff, ordered shutdown, status inspection, and per-server log capture for every spawned server - using the shared supervisor primitives, with behavior identical to the desktop supervisor. LiteLLM and OpenConnector SHALL be optional: `server.js` SHALL start in parallel with them and MUST NOT block on their readiness.

#### Scenario: server.js starts before optional services are healthy
- **WHEN** bundled LiteLLM and OpenConnector are spawned and `server.js` becomes healthy first
- **THEN** the launcher considers `server.js` ready without waiting for LiteLLM or OpenConnector
- **AND** the optional services continue starting in the background

#### Scenario: crashed sidecar self-heals
- **WHEN** a spawned LiteLLM or OpenConnector process exits unexpectedly
- **THEN** the launcher restarts it after a backoff delay
- **AND** `server.js` and the other services remain unaffected

#### Scenario: unhealthy optional service does not block server.js
- **WHEN** a bundled optional service fails its health check within the startup timeout
- **THEN** the launcher marks that service unhealthy with a clear error
- **AND** `server.js` starts and hides that service's panel, as it does today

### Requirement: Dev state location and gitignore
The launcher SHALL place all dev-generated state - `litellm.yaml`, the OpenConnector sqlite database, and the dev settings file - under `PLATFORM_DATA_DIR` (CWD-relative when unset, matching `paths.js`). The dev settings file (which contains generated credentials) SHALL be covered by `.gitignore` so generated secrets are not committed.

#### Scenario: dev state lives under the data dir
- **WHEN** the launcher seeds config and spawns services with `PLATFORM_DATA_DIR` unset
- **THEN** `litellm.yaml`, `openconnector.db`, and the dev settings file are written under the CWD-relative data dir
- **AND** not under the project source tree

#### Scenario: dev settings file is gitignored
- **WHEN** checking git ignore status of the dev settings file
- **THEN** it SHALL be matched by an entry in `.gitignore`
