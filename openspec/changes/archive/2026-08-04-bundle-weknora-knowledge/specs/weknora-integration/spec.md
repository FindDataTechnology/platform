## ADDED Requirements

### Requirement: WeKnora is bundled as a sidecar service
The Electron supervisor SHALL spawn the WeKnora Go binary as a child process on a free port when `WEKNORA_BASE_URL` is set to a localhost URL (e.g. `http://localhost:8080`). The supervisor SHALL health-check WeKnora's `/health` endpoint and restart it on failure. When `WEKNORA_BASE_URL` is set to a non-localhost URL, the supervisor SHALL NOT spawn WeKnora and SHALL use the remote instance as-is (graceful degradation).

#### Scenario: bundled WeKnora spawns on localhost
- **WHEN** `WEKNORA_BASE_URL=http://localhost:8080` is set in `.env`
- **AND** the `resources/weknora/` directory contains the WeKnora Go binary
- **THEN** the supervisor SHALL spawn the WeKnora binary on port 8080
- **AND** SHALL health-check its `/health` endpoint
- **AND** SHALL restart it on failure

#### Scenario: remote WeKnora is used as-is
- **WHEN** `WEKNORA_BASE_URL=https://kb.example.com` is set in `.env`
- **THEN** the supervisor SHALL NOT spawn a local WeKnora process
- **AND** SHALL connect to the remote URL directly

#### Scenario: WeKnora resources are absent
- **WHEN** `WEKNORA_BASE_URL` is set to a localhost URL
- **AND** the `resources/weknora/` directory is missing or empty
- **THEN** the supervisor SHALL log a warning and start without WeKnora
- **AND** the server SHALL start normally with chat and other behavior unchanged

### Requirement: Redis is bundled as a sidecar service
The Electron supervisor SHALL spawn a Redis binary (or Memurai on Windows) as a child process on a free port when WeKnora is spawned. WeKnora SHALL be configured to connect to this Redis instance via env vars (`REDIS_URL` or equivalent). When WeKnora is not spawned (remote URL or resources absent), Redis SHALL NOT be spawned.

#### Scenario: Redis spawns alongside WeKnora
- **WHEN** the supervisor spawns a local WeKnora process
- **THEN** the supervisor SHALL also spawn a Redis process on a free port
- **AND** SHALL configure WeKnora to connect to it via env vars

#### Scenario: Redis is not spawned when WeKnora is remote
- **WHEN** `WEKNORA_BASE_URL` is a non-localhost URL
- **THEN** the supervisor SHALL NOT spawn a Redis process

### Requirement: WeKnora connects to the existing embedded PostgreSQL
WeKnora SHALL connect to the existing embedded PostgreSQL instance (from the `bundle-postgres-embed-litellm` change) using the same connection parameters. WeKnora SHALL create its own schema or database within the shared Postgres instance. No second Postgres instance SHALL be spawned.

#### Scenario: WeKnora uses the shared Postgres
- **WHEN** the supervisor spawns WeKnora
- **THEN** WeKnora SHALL be configured with the same Postgres connection parameters as LiteLLM
- **AND** SHALL create its own schema or database within the shared instance
- **AND** SHALL NOT spawn a second Postgres process

### Requirement: WeKnora credentials are auto-provisioned
On first launch, the server SHALL generate a WeKnora API key and workspace (if not already present in `dev-settings.json`), persist them to `dev-settings.json`, and inject them into WeKnora's process env. The user SHALL NOT be required to log into WeKnora separately — Platform handles auth transparently.

#### Scenario: first launch auto-provisions credentials
- **WHEN** the server starts for the first time with WeKnora enabled
- **AND** `dev-settings.json` does not contain `WEKNORA_API_KEY`
- **THEN** the server SHALL generate a WeKnora API key and workspace
- **AND** SHALL persist them to `dev-settings.json`
- **AND** SHALL inject them into WeKnora's process env

#### Scenario: subsequent launches reuse credentials
- **WHEN** the server starts and `dev-settings.json` contains `WEKNORA_API_KEY`
- **THEN** the server SHALL reuse the existing credentials
- **AND** SHALL NOT regenerate them

### Requirement: WeKnora's LLM is configured to use Volces
WeKnora SHALL be configured to use the existing Volces provider (OpenAI-compatible API) for its LLM and embedding model via env vars injected into WeKnora's process (`VOLCES_API_KEY`, `VOLCES_BASE_URL`, model IDs). No new credentials SHALL be required.

#### Scenario: WeKnora uses Volces for LLM
- **WHEN** the supervisor spawns WeKnora
- **THEN** WeKnora SHALL be configured with `VOLCES_API_KEY` and `VOLCES_BASE_URL` from the server's env
- **AND** SHALL use the configured Volces model for indexing and retrieval

### Requirement: WeKnora's REST API is proxied with token injection
The server SHALL expose a thin HTTP client (`weknora.js`) for WeKnora's REST API, mirroring the pattern of `open-connector.js`. The server SHALL mount `/api/weknora/*` routes that proxy to WeKnora's REST API, injecting the WeKnora API token server-side. The browser SHALL NOT see or override the token.

#### Scenario: API routes proxy with token injection
- **WHEN** a client calls `/api/weknora/kb/list`
- **THEN** the server SHALL proxy the request to WeKnora's `/api/v1/kb/list`
- **AND** SHALL inject the WeKnora API token in the `Authorization` header
- **AND** SHALL NOT expose the token to the browser

#### Scenario: token cannot be overridden by the browser
- **WHEN** a client sends a request to `/api/weknora/*` with an `Authorization` header
- **THEN** the server SHALL ignore the client's header
- **AND** SHALL use the server-side token instead

### Requirement: WeKnora's web UI is reverse-proxied at /weknora-web
The server SHALL mount a reverse proxy at `/weknora-web` (plus root-level `/weknora-assets/*` if needed) that forwards to WeKnora's native web UI, injecting the WeKnora API token server-side. The proxy SHALL exclude WeKnora's internal API routes (which are handled by `/api/weknora/*`) and SHALL exclude authentication routes (which are auto-handled). The React SPA's catch-all route SHALL exclude `/weknora-web` so the iframe can load.

#### Scenario: iframe loads WeKnora's web UI
- **WHEN** the browser loads `/weknora-web` in an iframe
- **THEN** the server SHALL proxy the request to WeKnora's web UI
- **AND** SHALL inject the WeKnora API token
- **AND** SHALL return WeKnora's HTML/JS/CSS

#### Scenario: SPA catch-all excludes /weknora-web
- **WHEN** the browser requests `/weknora-web`
- **THEN** the server SHALL NOT fall through to the React SPA catch-all
- **AND** SHALL proxy to WeKnora instead

### Requirement: WeKnora is env-gated and degrades gracefully
When `WEKNORA_BASE_URL` is unset or the WeKnora resources are absent, the server SHALL disable the WeKnora endpoints and start normally with chat and other behavior unchanged. The React `/weknora` page SHALL show a placeholder message ("WeKnora not configured") when disabled.

#### Scenario: WeKnora is disabled when env is unset
- **WHEN** `WEKNORA_BASE_URL` is not set in `.env`
- **THEN** the server SHALL NOT mount `/api/weknora/*` or `/weknora-web` routes
- **AND** SHALL start normally with chat and other behavior unchanged
- **AND** the React `/weknora` page SHALL show a placeholder message

#### Scenario: WeKnora is disabled when resources are absent
- **WHEN** `WEKNORA_BASE_URL` is set to a localhost URL
- **AND** the `resources/weknora/` directory is missing
- **THEN** the server SHALL log a warning and start without WeKnora
- **AND** the React `/weknora` page SHALL show a placeholder message
