## ADDED Requirements

### Requirement: Provider credentials are resolved per-request from a hot-reloaded store
The server SHALL route upstream provider API keys (`LLM_API_KEY`, `LITELLM_API_KEY`) into dsh's `dsh-credentials-local` hot-reloaded credential store (`.credentials.yaml`, 0600 perms) rather than reading them once from `process.env` at boot. A rotated key SHALL reach the **next LLM request** without a dsh process restart, because `dsh-credentials-local` resolves the key per request and hot-reloads the file. The store SHALL be seeded from `process.env` on first run when the file is absent.

#### Scenario: rotated key takes effect without restart
- **WHEN** an upstream provider API key is changed (written to `.credentials.yaml`)
- **THEN** the next LLM request SHALL use the new key
- **AND** the dsh process SHALL NOT be restarted

#### Scenario: credential store seeded from env on first run
- **WHEN** the server starts and `.credentials.yaml` is absent
- **THEN** the server SHALL seed it from the configured `process.env` keys
- **AND** the file SHALL be written with 0600 permissions

### Requirement: LiteLLM credentials do not leak to the browser
The server SHALL NOT expose `LITELLM_API_KEY` (or any upstream provider key) to the browser. The `/api/litellm/credentials` route SHALL be removed or replaced by the existing cookie-based auto-login used for the LiteLLM `/ui` iframe, so local mode aligns with the already-correct remote mode. Credentials SHALL remain server-side only (project convention: tokens never reach the browser).

#### Scenario: credentials route does not return the key
- **WHEN** a browser client requests the LiteLLM credentials endpoint
- **THEN** the response SHALL NOT contain the `LITELLM_API_KEY`
- **AND** LiteLLM UI access SHALL be provided via the server-set login cookie instead
