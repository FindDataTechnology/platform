## ADDED Requirements

### Requirement: OpenConnector panel toggles alongside Chat and Knowledge
The web UI SHALL provide an "OpenConnector" panel toggled by a header button, hiding the chat view and input area when active (mirroring the Knowledge panel toggle). When the panel is opened, the UI SHALL fetch `GET /api/openconnector/config` and `GET /api/openconnector/health` to determine whether the module is enabled and whether the runtime is reachable, and SHALL display that status to the user.

#### Scenario: module disabled
- **WHEN** the panel is opened and `/api/openconnector/config` returns `enabled: false`
- **THEN** the UI SHALL show a clear "OpenConnector is disabled" state with setup guidance
- **AND** SHALL NOT attempt further runtime calls

#### Scenario: module enabled but runtime unreachable
- **WHEN** the panel is opened and `enabled` is true but the health check fails
- **THEN** the UI SHALL show a "runtime unreachable" state without crashing
- **AND** SHALL allow the user to retry the health check

#### Scenario: module enabled and runtime reachable
- **WHEN** the panel is opened and the health check succeeds
- **THEN** the UI SHALL show a "connected" status and enable the catalog, connections, and execution areas

### Requirement: Users can browse providers and search actions
The panel SHALL let users browse the provider list and search Actions by keyword. Searching SHALL call `GET /api/openconnector/actions/search?q=` (server-side search); the full catalog SHALL NOT be loaded into the browser at once. Each result SHALL display the action id, provider/service, and a short description.

#### Scenario: search actions
- **WHEN** the user types a query and submits the search
- **THEN** the UI SHALL call `/api/openconnector/actions/search?q=<query>` and render the matching actions
- **AND** SHALL show an empty-state message when there are no matches

#### Scenario: list actions for a provider
- **WHEN** the user selects a provider/service
- **THEN** the UI SHALL fetch that service's actions and render them

### Requirement: Users can inspect an action's schema and agent guide
The panel SHALL let users open an Action to inspect its input schema, required scopes, and the agent-readable guide. Inspecting SHALL call `GET /api/openconnector/actions/:actionId` and `GET /api/openconnector/actions/:actionId/guide`.

#### Scenario: inspect an action
- **WHEN** the user opens an action
- **THEN** the UI SHALL fetch and render the action's contract (input schema and scopes) and its agent guide markdown
- **AND** SHALL offer to run the action from the inspector

### Requirement: Users can manage API-key connections
The panel SHALL let users list configured connections, add an API-key (or no-auth) connection for a provider, and remove a connection. Add SHALL call `PUT /api/openconnector/connections/:service` with `{ authType, values }`; remove SHALL call `DELETE /api/openconnector/connections/:service`. Credential values entered in the browser SHALL be sent only to pi-web-chat's proxy and SHALL NOT be logged or persisted by the UI.

#### Scenario: add an API-key connection
- **WHEN** the user submits a provider, auth type, and API key
- **THEN** the UI SHALL PUT to `/api/openconnector/connections/:service` and refresh the connection list on success

#### Scenario: remove a connection
- **WHEN** the user clicks remove on a connection
- **THEN** the UI SHALL DELETE `/api/openconnector/connections/:service` and remove the row from the list

#### Scenario: list authenticated connections
- **WHEN** the panel's connections area is shown
- **THEN** the UI SHALL fetch `/api/openconnector/connections` and render each connection with its provider and identity label

### Requirement: Users can execute an action for debugging
The panel SHALL let users execute an Action from its inspector by providing an `input` JSON object and an optional connection alias. Execution SHALL call `POST /api/openconnector/actions/:actionId/execute` with `{ input, alias? }`. The UI SHALL show a loading state while the call is in flight and render the result or error envelope on completion.

#### Scenario: execute an action successfully
- **WHEN** the user submits input and triggers execution
- **THEN** the UI SHALL POST to `/api/openconnector/actions/:actionId/execute`
- **AND** SHALL render the returned result data on success

#### Scenario: action execution fails
- **WHEN** the runtime returns `success: false` or the HTTP call errors
- **THEN** the UI SHALL render the error message from the envelope without crashing

### Requirement: Panel degrades gracefully and never exposes tokens
The panel SHALL make all runtime calls through `/api/openconnector/*` only; it SHALL NOT call the OpenConnector runtime URL directly. The panel SHALL tolerate any single failed call by showing an inline error and remaining usable. The UI SHALL never display, log, or transmit the runtime or admin tokens.

#### Scenario: a runtime call fails mid-session
- **WHEN** an individual `/api/openconnector/*` call fails while the panel is open
- **THEN** the UI SHALL show an inline error for that area
- **AND** SHALL keep the rest of the panel functional

#### Scenario: tokens are never present in the client
- **WHEN** any panel operation is performed
- **THEN** no request SHALL be sent to the runtime base URL directly
- **AND** no token value SHALL appear in the DOM, console, or outgoing requests
