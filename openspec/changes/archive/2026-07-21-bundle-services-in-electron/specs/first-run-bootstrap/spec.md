## ADDED Requirements

### Requirement: Idempotent first-run initialization
The Electron main process SHALL run a first-run bootstrap step exactly once per fresh `userData/` directory, before the supervisor starts. The bootstrap SHALL be idempotent: on any subsequent launch it SHALL detect existing user files and MUST NOT overwrite them.

#### Scenario: Fresh install, first launch
- **WHEN** the app launches and `userData/settings.json` does not exist
- **THEN** the bootstrap writes a default `settings.json` atomically (temp file + rename) containing the baked Volces fallback key and any generated tokens
- **AND** the supervisor sees the seeded values via `resolveEnv()`

#### Scenario: Second launch with existing settings
- **WHEN** the app launches and `userData/settings.json` already exists
- **THEN** the bootstrap does NOT overwrite it
- **AND** does NOT regenerate tokens already present in it
- **AND** completes without error

### Requirement: OpenConnector token generation
The bootstrap SHALL generate cryptographically random `OPENCONNECTOR_RUNTIME_TOKEN` and `OPENCONNECTOR_ADMIN_TOKEN` values (32 bytes hex-encoded) on first run when the bundled OpenConnector resources are present AND these tokens are absent from `settings.json`. Generated tokens SHALL be persisted to `settings.json` via an atomic write. Tokens MUST NOT be transmitted to any renderer process.

#### Scenario: First run seeds OC tokens
- **WHEN** bundled OC resources are present
- **AND** `settings.json` lacks `OPENCONNECTOR_RUNTIME_TOKEN`
- **THEN** the bootstrap generates a 32-byte hex random token and stores it in `settings.json`
- **AND** repeats for `OPENCONNECTOR_ADMIN_TOKEN`
- **AND** injects both into the OpenConnector child's env at spawn time

#### Scenario: Tokens stay server-side
- **WHEN** the browser or any renderer requests configuration data via WS or HTTP
- **THEN** the server response MUST NOT include `OPENCONNECTOR_RUNTIME_TOKEN` or `OPENCONNECTOR_ADMIN_TOKEN`

### Requirement: LiteLLM default config seeding
The bootstrap SHALL copy the bundled default LiteLLM config (`resources/litellm/default-config.yaml`) to `userData/litellm.yaml` on first run when the bundled LiteLLM resources are present AND `userData/litellm.yaml` does not exist. The copy SHALL be atomic (temp file + rename). If bundled LiteLLM resources are absent (dev mode or external-only builds), the bootstrap SHALL skip this step without erroring.

#### Scenario: Fresh install seeds default litellm.yaml
- **WHEN** bundled LiteLLM resources exist
- **AND** `userData/litellm.yaml` does not exist
- **THEN** the bootstrap copies `resources/litellm/default-config.yaml` to `userData/litellm.yaml` atomically
- **AND** the LiteLLM child reads that path via its `--config` arg

#### Scenario: User edits are preserved
- **WHEN** `userData/litellm.yaml` already exists (edited by the user or a prior run)
- **THEN** the bootstrap does NOT overwrite it
- **AND** the LiteLLM child continues reading the user's version

### Requirement: LiteLLM master key generation
The bootstrap SHALL generate a `LITELLM_API_KEY` (`sk-` + 32-byte hex random) on first run when bundled LiteLLM resources are present AND `LITELLM_API_KEY` is absent from `settings.json`. The key SHALL be persisted to `settings.json` atomically and injected into both the LiteLLM child's env (`master_key`) and `server.js`'s env (`LITELLM_API_KEY`) so `server.js` can call the bundled proxy.

#### Scenario: First run seeds LiteLLM master key
- **WHEN** bundled LiteLLM resources are present
- **AND** `settings.json` lacks `LITELLM_API_KEY`
- **THEN** the bootstrap generates `sk-<hex32>` and stores it in `settings.json`
- **AND** both processes receive it via env

### Requirement: Bootstrap failure never blocks app launch
If any bootstrap step fails (disk full, permission denied, corrupt existing file), the bootstrap SHALL log the failure, leave `userData/` in a recoverable state, and allow the supervisor to proceed. The supervisor's graceful-degradation contract SHALL cover missing tokens or config by marking the affected optional server `unhealthy`.

#### Scenario: Corrupt settings.json
- **WHEN** `userData/settings.json` exists but cannot be parsed as JSON
- **THEN** the bootstrap logs an error and leaves the file untouched
- **AND** the supervisor treats OC/LiteLLM tokens as absent and marks those services `unhealthy`
- **AND** the app window still opens with the Volces fallback provider working
