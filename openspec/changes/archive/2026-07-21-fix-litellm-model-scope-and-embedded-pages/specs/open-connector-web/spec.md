## ADDED Requirements

### Requirement: Server exposes OpenConnector-enabled state to the client
The server SHALL include a boolean `openconnectorEnabled` field in the `/api/config` JSON response indicating whether the OpenConnector module is enabled (`OPENCONNECTOR_BASE_URL` set). The client SHALL use this field to render the OpenConnector view's embedded iframe when the module is enabled and the disabled placeholder when it is not.

#### Scenario: OpenConnector configured
- **WHEN** the client requests `/api/config` and the OpenConnector module is enabled
- **THEN** the response SHALL include `openconnectorEnabled: true`

#### Scenario: OpenConnector not configured
- **WHEN** the client requests `/api/config` and the OpenConnector module is not enabled
- **THEN** the response SHALL include `openconnectorEnabled: false`
