# dsh-llm-providers Specification

## Purpose
TBD - created by archiving change migrate-pi-to-dsh. Update Purpose after archive.
## Requirements
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
