## ADDED Requirements

### Requirement: Module is env-gated and disabled when the runtime URL is unset
The server SHALL read `OPENCONNECTOR_BASE_URL`, `OPENCONNECTOR_RUNTIME_TOKEN`, and `OPENCONNECTOR_ADMIN_TOKEN` from the environment at startup. When `OPENCONNECTOR_BASE_URL` is unset, the server SHALL disable the OpenConnector module (skip MCP registration and skip mounting the `/api/openconnector/*` endpoints) and start normally with existing chat and MCP behavior unchanged. When set, the server SHALL initialize the module with the configured base URL and tokens.

#### Scenario: base URL unset
- **WHEN** `OPENCONNECTOR_BASE_URL` is not present in the environment
- **THEN** the server SHALL start without mounting `/api/openconnector/*` endpoints and without registering an OpenConnector MCP server
- **AND** the server SHALL log a notice that OpenConnector is disabled

#### Scenario: base URL set
- **WHEN** `OPENCONNECTOR_BASE_URL` is set to a reachable runtime URL
- **THEN** the server SHALL initialize the OpenConnector module with that base URL and any provided runtime/admin tokens
- **AND** the server SHALL mount the `/api/openconnector/*` endpoints and register the OpenConnector MCP server

### Requirement: Server proxies the OpenConnector runtime API with the correct token per endpoint family
The server SHALL expose `/api/openconnector/*` REST endpoints that proxy calls to the configured OpenConnector runtime. Calls to runtime (`/v1/*`) and action-execution endpoints SHALL use the runtime token (`OPENCONNECTOR_RUNTIME_TOKEN`) as `Authorization: Bearer`; calls to admin (`/api/*`) endpoints SHALL use the admin token (`OPENCONNECTOR_ADMIN_TOKEN`). The server SHALL forward the runtime's uniform JSON envelope (`{ success, message, data, meta }`) to the caller.

#### Scenario: runtime endpoint uses the runtime token
- **WHEN** a client calls `GET /api/openconnector/health` (or any action execute / `/v1`-backed endpoint)
- **THEN** the server SHALL call the corresponding runtime `/v1/*` endpoint with the runtime token in the `Authorization` header
- **AND** SHALL return the runtime's response envelope to the client

#### Scenario: admin endpoint uses the admin token
- **WHEN** a client calls an endpoint backed by the runtime's `/api/*` (e.g. connections, providers catalog, runs)
- **THEN** the server SHALL call the runtime `/api/*` endpoint with the admin token in the `Authorization` header
- **AND** SHALL return the runtime's response envelope to the client

#### Scenario: runtime returns an error envelope
- **WHEN** the runtime responds with `success: false` or an HTTP error status
- **THEN** the server SHALL surface the error (status and message) to the client rather than crashing

### Requirement: Server exposes catalog, action, connection, execution, and run endpoints
The server SHALL expose endpoints that proxy the runtime's: runtime health (`GET /api/openconnector/health`); providers (`GET /api/openconnector/providers`); actions list with optional `service` filter and search (`GET /api/openconnector/actions`, `GET /api/openconnector/actions/search?q=`); a single action's contract and its agent guide (`GET /api/openconnector/actions/:actionId`, `GET /api/openconnector/actions/:actionId/guide`); connections list/add/remove (`GET /api/openconnector/connections`, `PUT /api/openconnector/connections/:service`, `DELETE /api/openconnector/connections/:service`); action execution (`POST /api/openconnector/actions/:actionId/execute` with body `{ input, alias? }`); and recent runs (`GET /api/openconnector/runs`).

#### Scenario: browse and search actions
- **WHEN** a client calls `GET /api/openconnector/actions/search?q=github`
- **THEN** the server SHALL proxy the runtime's action search and return matching action contracts in the envelope's `data`

#### Scenario: add an API-key connection
- **WHEN** a client sends `PUT /api/openconnector/connections/github` with body `{ authType: "api_key", values: { apiKey: "..." } }`
- **THEN** the server SHALL proxy `PUT /api/connections/github` to the runtime with the admin token and return the runtime's result

#### Scenario: execute an action with an alias
- **WHEN** a client sends `POST /api/openconnector/actions/github.get_current_user/execute` with body `{ input: {}, alias: "work" }`
- **THEN** the server SHALL proxy `POST /v1/actions/github.get_current_user` to the runtime with the runtime token, the `x-oo-connector-alias: work` header, and body `{ input: {} }`
- **AND** SHALL return the action result envelope to the client

### Requirement: Server registers the OpenConnector MCP endpoint with the agent when enabled
When the module is enabled, the server SHALL build an HTTP MCP server config pointing at `<base>/mcp` (with the runtime token as a Bearer header) and merge it into the existing MCP connect step so the runtime's tools (`list_apps`, `search_actions`, `get_action_guide`, `execute_action`) are registered as agent-callable tools. The OpenConnector tool names SHALL be added to the agent session's `tools` allowlist. A failure to connect the OpenConnector MCP server SHALL NOT prevent the agent session from starting.

#### Scenario: OpenConnector tools are available to the agent
- **WHEN** the module is enabled and the runtime's `/mcp` endpoint is reachable
- **THEN** the agent session SHALL have the four OpenConnector MCP tools available (named with the `mcp__open-connector__` prefix)
- **AND** the server SHALL log how many OpenConnector tools were registered

#### Scenario: OpenConnector MCP server fails to connect
- **WHEN** the runtime is unreachable or the `/mcp` handshake fails at startup
- **THEN** the server SHALL log a warning identifying the failed server, skip its tools, and proceed to start the agent session with the remaining tools

### Requirement: Config endpoint exposes only the base URL and enabled state
The server SHALL expose `GET /api/openconnector/config` returning only `{ enabled, baseUrl }` (where `baseUrl` is the configured runtime base URL). The server SHALL NEVER include the runtime token or admin token in any response sent to the browser.

#### Scenario: config endpoint omits tokens
- **WHEN** a client calls `GET /api/openconnector/config`
- **THEN** the response SHALL contain only the `enabled` flag and the `baseUrl`
- **AND** SHALL NOT contain the runtime token or admin token in any form

### Requirement: Proxy rejects client-supplied token overrides
The server SHALL NOT forward any `Authorization` header or token-like field supplied by the browser client to the runtime; only the server-held runtime/admin tokens SHALL be used for runtime calls.

#### Scenario: client attempts to override the token
- **WHEN** a client sends an `Authorization` header or a token field in a request body to `/api/openconnector/*`
- **THEN** the server SHALL ignore it and authenticate to the runtime using only the server-held token
