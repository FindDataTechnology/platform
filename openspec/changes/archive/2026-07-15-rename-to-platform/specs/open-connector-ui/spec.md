## MODIFIED Requirements

### Requirement: Users can manage API-key connections
The panel SHALL let users list configured connections, add an API-key (or no-auth) connection for a provider, and remove a connection. Add SHALL call `PUT /api/openconnector/connections/:service` with `{ authType, values }`; remove SHALL call `DELETE /api/openconnector/connections/:service`. Credential values entered in the browser SHALL be sent only to Platform's proxy and SHALL NOT be logged or persisted by the UI.

#### Scenario: add an API-key connection
- **WHEN** the user submits a provider, auth type, and API key
- **THEN** the UI SHALL PUT to `/api/openconnector/connections/:service` and refresh the connection list on success

#### Scenario: remove a connection
- **WHEN** the user clicks remove on a connection
- **THEN** the UI SHALL DELETE `/api/openconnector/connections/:service` and remove the row from the list

#### Scenario: list authenticated connections
- **WHEN** the panel's connections area is shown
- **THEN** the UI SHALL fetch `/api/openconnector/connections` and render each connection with its provider and identity label
