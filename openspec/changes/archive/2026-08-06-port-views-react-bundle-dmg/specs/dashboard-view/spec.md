## ADDED Requirements

### Requirement: Dashboard view shows system status

The React Dashboard view at `/dashboard` SHALL present a read-only overview of the running system: supervisor server states (id, kind, state, port, last error), the active provider and current model, document and collection counts, and the count of connected MCP tools. It SHALL fetch this from a new `/api/supervisor/status` REST route that works identically in dev (`npm start`) and the packaged Electron app.

#### Scenario: Dashboard renders server states
- **WHEN** the user navigates to `/dashboard`
- **THEN** the view SHALL GET `/api/supervisor/status`
- **AND** SHALL render a row per server (server-js, pi-agent, litellm, openconnector) showing its id, kind, state, and assigned port

#### Scenario: Dashboard shows active model and provider
- **WHEN** the dashboard loads
- **THEN** it SHALL display the current chat model id and the active provider name

#### Scenario: Dashboard shows document and collection counts
- **WHEN** the dashboard loads
- **THEN** it SHALL display the total document count and collection count
- **AND** SHALL distinguish `ready` vs. `indexing` vs. `error` documents

#### Scenario: Dashboard shows MCP tool count
- **WHEN** the dashboard loads
- **THEN** it SHALL display the number of MCP tools registered with the agent

### Requirement: Supervisor status route excludes secrets

The `/api/supervisor/status` REST route SHALL return only non-secret fields: server id, name, kind, state, pid, port, url, restart count, last check time, last error, and recent log lines. It SHALL NOT include any API keys, tokens, or credentials.

#### Scenario: No secrets in status response
- **WHEN** the dashboard requests `/api/supervisor/status`
- **THEN** the JSON response SHALL NOT contain any field whose value is an API key, runtime token, or admin token
- **AND** SHALL NOT contain `OPENCONNECTOR_RUNTIME_TOKEN`, `OPENCONNECTOR_ADMIN_TOKEN`, `LITELLM_API_KEY`, or `VOLCES_API_KEY`

### Requirement: Dashboard refreshes on demand

The Dashboard view SHALL provide a manual refresh control and SHALL NOT auto-poll at a high rate. It MAY refresh on a slow interval (>= 10s) if implemented.

#### Scenario: Manual refresh
- **WHEN** the user clicks Refresh
- **THEN** the view SHALL re-fetch `/api/supervisor/status` and update the displayed rows

#### Scenario: Unreachable supervisor route degrades
- **WHEN** `/api/supervisor/status` returns an error or the request fails
- **THEN** the dashboard SHALL show an error state with a retry control
- **AND** SHALL NOT crash the React app
