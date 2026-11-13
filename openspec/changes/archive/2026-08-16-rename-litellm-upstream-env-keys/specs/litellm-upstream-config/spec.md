# Delta spec — litellm-upstream-config

## ADDED Requirements

### Requirement: Provider-neutral LiteLLM upstream env keys
The system SHALL name the bundled LiteLLM upstream endpoint and credentials with provider-neutral environment variables `LLM_UPSTREAM_BASE_URL`, `LLM_UPSTREAM_KEY_1`, and `LLM_UPSTREAM_KEY_2`. The default LiteLLM config (`litellm.yaml`) MUST reference these names via `os.environ/`.

#### Scenario: Default config uses neutral names
- **WHEN** the seeded `litellm.yaml` is read
- **THEN** every model block references `os.environ/LLM_UPSTREAM_BASE_URL`, `os.environ/LLM_UPSTREAM_KEY_1`, or `os.environ/LLM_UPSTREAM_KEY_2`
- **AND** no model block references a `VOLCES_PLAN_*` name

#### Scenario: Upstream keys forwarded to the LiteLLM child
- **WHEN** the supervisor builds the LiteLLM child process environment
- **THEN** the child receives `LLM_UPSTREAM_BASE_URL`, `LLM_UPSTREAM_KEY_1`, and `LLM_UPSTREAM_KEY_2`

### Requirement: New names take precedence over legacy names
When both a new `LLM_UPSTREAM_*` key and its legacy `VOLCES_PLAN_*` counterpart are present, the system SHALL use the new `LLM_UPSTREAM_*` value. When only the legacy name is present, the system SHALL resolve the upstream from the legacy value.

#### Scenario: Both new and legacy set
- **WHEN** both `LLM_UPSTREAM_KEY_1` and `VOLCES_PLAN_KEY_1` are present in the resolved env
- **THEN** the LiteLLM child receives the `LLM_UPSTREAM_KEY_1` value

#### Scenario: Only legacy set
- **WHEN** only `VOLCES_PLAN_KEY_1` is present and `LLM_UPSTREAM_KEY_1` is absent
- **THEN** the LiteLLM child receives the legacy `VOLCES_PLAN_KEY_1` value as its `LLM_UPSTREAM_KEY_1`

### Requirement: Base URL default fallback
When neither `LLM_UPSTREAM_BASE_URL` nor `VOLCES_PLAN_BASE_URL` is set, the system SHALL fall back to the built-in default upstream base URL.

#### Scenario: No upstream base URL configured
- **WHEN** neither `LLM_UPSTREAM_BASE_URL` nor `VOLCES_PLAN_BASE_URL` is present
- **THEN** the LiteLLM child receives the built-in default upstream base URL

### Requirement: Settings pass-through accepts both names
The settings/env pass-through (`electron/config/settings.js` and `local-services.js`) SHALL forward both the new `LLM_UPSTREAM_*` keys and the legacy `VOLCES_PLAN_*` keys into the agent environment so either naming resolves downstream.

#### Scenario: Packaged settings use legacy names
- **WHEN** `settings.json` contains `VOLCES_PLAN_KEY_1` and not `LLM_UPSTREAM_KEY_1`
- **THEN** the resolved environment forwards `VOLCES_PLAN_KEY_1` so the upstream resolves
