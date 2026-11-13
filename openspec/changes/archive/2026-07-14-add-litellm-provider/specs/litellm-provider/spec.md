## ADDED Requirements

### Requirement: Server registers the LiteLLM proxy as a provider
The server SHALL register a LiteLLM proxy as a Pi provider by loading the `pi-provider-litellm` extension through the agent resource loader's extension factories, configured from the `LITELLM_BASE_URL` and `LITELLM_API_KEY` environment variables. The provider SHALL be named `litellm`, and its model list SHALL be discovered from the proxy rather than hardcoded.

#### Scenario: extension registered at startup
- **WHEN** the server starts with `LITELLM_BASE_URL` and `LITELLM_API_KEY` set to a reachable LiteLLM proxy
- **THEN** the server SHALL load the `pi-provider-litellm` extension, register a provider named `litellm`, and discover its models from the proxy

#### Scenario: proxy unreachable at startup
- **WHEN** the server starts with `LITELLM_BASE_URL` set but the proxy is unreachable
- **THEN** the server SHALL bound discovery to a short timeout, log a warning, and continue startup with the Volces provider still available and no litellm models listed

#### Scenario: LiteLLM not configured
- **WHEN** the server starts without `LITELLM_BASE_URL` or `LITELLM_API_KEY`
- **THEN** the server SHALL log a warning and continue startup without registering the litellm provider

### Requirement: Server loads environment configuration from .env
The server SHALL load environment variables from a `.env` file at startup, before initializing the agent, so that LiteLLM configuration is available to the extension.

#### Scenario: .env present
- **WHEN** a `.env` file exists containing `LITELLM_BASE_URL` and `LITELLM_API_KEY`
- **THEN** the server SHALL expose those values on `process.env` before the `pi-provider-litellm` extension is loaded

#### Scenario: .env absent
- **WHEN** no `.env` file exists
- **THEN** the server SHALL continue startup using existing `process.env` values and hardcoded fallbacks without crashing

### Requirement: LiteLLM models are discoverable and selectable
The server SHALL include models discovered from the LiteLLM proxy in the model list sent to clients by including `litellm` in the set of exposed providers, and SHALL allow the active model to be switched to any available litellm model.

#### Scenario: litellm models appear in the model list
- **WHEN** a client sends `{ "type": "list_models" }` and the litellm proxy has discoverable models
- **THEN** the server SHALL include those models in the `models` response, each with `provider: "litellm"`

#### Scenario: switch to a litellm model
- **WHEN** a client sends `{ "type": "set_model", "id": "<litellm model id>" }` for a model in the available list and the agent is not streaming
- **THEN** the server SHALL switch the session's active model and broadcast `{ "type": "model_changed", "id": "<litellm model id>" }`

### Requirement: Web UI links to the LiteLLM management web
The server SHALL expose the LiteLLM proxy's management UI URL to the client, derived from the configured base URL, and the web UI SHALL render a link that opens it in a new tab so models, keys, and routes are administered in LiteLLM's official management web.

#### Scenario: client fetches the management URL
- **WHEN** the client requests the server configuration
- **THEN** the server SHALL return the LiteLLM management URL as `${LITELLM_BASE_URL}/ui`

#### Scenario: management URL omitted when unconfigured
- **WHEN** LiteLLM is not configured (`LITELLM_BASE_URL` unset)
- **THEN** the server SHALL omit the management URL from the configuration response

#### Scenario: user opens the management UI
- **WHEN** the user clicks the management link in the web UI
- **THEN** the browser SHALL open `${LITELLM_BASE_URL}/ui` in a new tab

### Requirement: API key is excluded from version control
The project SHALL ignore the `.env` file in version control so the LiteLLM API key is not committed.

#### Scenario: .env ignored by git
- **WHEN** checking git ignore status of `.env`
- **THEN** `.env` SHALL be matched by an entry in `.gitignore`
