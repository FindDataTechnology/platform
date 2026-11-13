## ADDED Requirements

### Requirement: Bundled LiteLLM proxy is seeded with the Agent-harness alias and Volces plan/v3 models
The bundled LiteLLM proxy's seeded configuration (`resources/litellm/default-config.yaml`, copied to the data directory as `litellm.yaml` on first run) SHALL register an `Agent-harness` model alias routing to `glm-5.2` and the four selectable models `doubao-seed-2-0-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, and `glm-5.2`, all backed by the Volces plan/v3 endpoint (`api_base: https://ark.cn-beijing.volces.com/api/plan/v3`), authenticated via the configured plan/v3 keys (`VOLCES_PLAN_KEY_1` / `VOLCES_PLAN_KEY_2`) with rotation (two deployments per `model_name`, one per key, so the LiteLLM router load-balances and retries across keys). The `Agent-harness` alias SHALL be the default chat model (`DEFAULT_MODEL=Agent-harness`). The seeded `model_list` SHALL NOT include the legacy coding/v3 chat models (`volces-coding`, `volces-coding-plan-v3`); the documents RAG continues to use the Volces coding/v3 endpoint directly via `VOLCES_BASE_URL`/`VOLCES_API_KEY`, not through the proxy. The plan/v3 keys SHALL be referenced via `os.environ/` (never hardcoded in the checked-in template) and SHALL NOT reach the browser.

#### Scenario: proxy reports the intended model set
- **WHEN** the seeded LiteLLM proxy is running and a client calls `GET ${LITELLM_BASE_URL}/v1/models` with the master key
- **THEN** the response SHALL include exactly `Agent-harness`, `doubao-seed-2-0-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, and `glm-5.2`
- **AND** SHALL NOT include `volces-coding` or `volces-coding-plan-v3`

#### Scenario: Agent-harness routes to glm-5.2
- **WHEN** a client sends a chat-completion request to the `Agent-harness` model name
- **THEN** the proxy SHALL route the request to the `glm-5.2` upstream model at the Volces plan/v3 endpoint

#### Scenario: default model is Agent-harness
- **WHEN** the server starts with LiteLLM configured and `DEFAULT_MODEL=Agent-harness`
- **THEN** the agent session SHALL start on `Agent-harness`
- **AND** the `current_model` sent to the client on connect SHALL be `Agent-harness`

#### Scenario: plan/v3 keys are not committed and not exposed to the browser
- **WHEN** checking the checked-in `resources/litellm/default-config.yaml` template
- **THEN** the plan/v3 keys SHALL be referenced via `os.environ/VOLCES_PLAN_KEY_1` and `os.environ/VOLCES_PLAN_KEY_2`, not as literal key values
- **AND** the browser SHALL never receive `VOLCES_PLAN_KEY_1` or `VOLCES_PLAN_KEY_2`
