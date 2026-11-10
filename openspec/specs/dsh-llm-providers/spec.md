# dsh-llm-providers Specification

## Purpose
How upstream LLM providers are wired into the dsh runtime: the Volces (火山引擎) OpenAI-compatible endpoint is registered as a dsh `ctx.llm` adapter plugin, API keys are routed through dsh's hot-reloaded `dsh-credentials-local` store so a rotated key reaches the next request without a restart, a hosted cell's bound ciyuan account key overrides the deployment seed for the ciyuan provider's env ref, and every generated provider profile carries a bounded exponential-backoff retry policy for transient failures.
## Requirements

### Requirement: A bound ciyuan account overrides the deployment seed per hosted cell

In hosted deployments where each cell serves exactly one identity, the credential store writer SHALL, when that identity has a bound ciyuan account key, write it as the value of the ciyuan provider's env ref (`LLM_PROVIDER_KEY_FINDDATA`) instead of the deployment seed from `llm-providers.json`. The override SHALL ride the same hot-reloaded store, so it reaches the **next LLM request** without a dsh restart; removing the binding (disconnect or stale) SHALL restore the seed value on the next store write. In single-process deployments serving several identities from one store, the writer SHALL NOT apply any per-identity override.

#### Scenario: bound key wins over the seed in a cell

- **WHEN** the cell's identity binds a ciyuan account and the credential store is rewritten
- **THEN** `.credentials.yaml` carries the user's key under `LLM_PROVIDER_KEY_FINDDATA`
- **AND** the next LLM request uses it with no dsh restart

#### Scenario: unbinding restores the seed

- **WHEN** the identity disconnects (or the key is marked stale) and the store is rewritten
- **THEN** `LLM_PROVIDER_KEY_FINDDATA` equals the `llm-providers.json` seed again

#### Scenario: shared single-process store is never overridden

- **WHEN** the server runs single-process for several identities
- **THEN** no identity's ciyuan key is written into the shared credential store

### Requirement: Volces provider is registered as a dsh llm adapter plugin

The server SHALL register the Volces (火山引擎) OpenAI-compatible endpoint as a dsh `ctx.llm` adapter plugin (or llm profile entry) rather than a pi provider extension. The adapter SHALL carry the base URL, API key (resolved from `VOLCES_API_KEY` or the fallback), the `openai-completions` API style, and the model list (deepseek-v4-pro, glm-5.2, etc.). The Volces provider SHALL be added to the set of exposed providers in the model selector.

#### Scenario: Volces adapter loaded at startup
- **WHEN** the server starts with `VOLCES_API_KEY` set (or the fallback available)
- **THEN** the dsh runtime SHALL load the Volces llm adapter and Volces models SHALL appear in `list_models`

#### Scenario: Volces not configured
- **WHEN** `VOLCES_API_KEY` is unset and no fallback is available
- **THEN** the Volces adapter SHALL NOT be loaded and the server SHALL log a warning

### Requirement: Provider credentials are resolved per-request from a hot-reloaded store
The server SHALL route upstream provider API keys (`LLM_API_KEY`) into dsh's `dsh-credentials-local` hot-reloaded credential store (`.credentials.yaml`, 0600 perms) rather than reading them once from `process.env` at boot. A rotated key SHALL reach the **next LLM request** without a dsh process restart, because `dsh-credentials-local` resolves the key per request and hot-reloads the file. The store SHALL be seeded from `process.env` on first run when the file is absent.

#### Scenario: rotated key takes effect without restart
- **WHEN** an upstream provider API key is changed (written to `.credentials.yaml`)
- **THEN** the next LLM request SHALL use the new key
- **AND** the dsh process SHALL NOT be restarted

#### Scenario: credential store seeded from env on first run
- **WHEN** the server starts and `.credentials.yaml` is absent
- **THEN** the server SHALL seed it from the configured `process.env` keys
- **AND** the file SHALL be written with 0600 permissions

### Requirement: Generated provider profiles carry a transient-error retry policy

Every LLM provider profile the platform generates (the env-driven default route and every user-added route from the Models page) SHALL carry a retry policy that retries transient request failures with bounded exponential backoff. The retryable set SHALL include rate-limit rejections, server errors, timeouts, transport failures, empty responses, and the adapter's unrecognized-error fallback bucket (a gateway whose rejection wording defeats message-pattern classification must still be retried). The policy SHALL be bounded (finite attempts, capped delay, jittered) — never unbounded retrying. Policy changes SHALL take effect via the settings hot-reload path without a runtime restart.

#### Scenario: concurrency-limited request is retried, not fatal
- **WHEN** the gateway rejects a model request with a concurrency-limit rejection whose text contains neither a status code nor the words "rate limit"
- **THEN** the request SHALL be retried with backoff up to the configured finite budget
- **AND** the turn SHALL complete normally if a retry succeeds

#### Scenario: policy applies to user-added routes
- **WHEN** a user adds or edits a provider on the Models page
- **THEN** the generated profile for that route SHALL carry the same retry policy semantics as the default route

#### Scenario: policy reaches the runtime without restart
- **WHEN** the generated settings section changes a provider's retry policy
- **THEN** the running runtime SHALL pick up the new policy via settings hot-reload
- **AND** the next failed request SHALL be governed by the new policy
