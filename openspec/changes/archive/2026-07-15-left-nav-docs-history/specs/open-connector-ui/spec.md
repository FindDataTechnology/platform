## MODIFIED Requirements

### Requirement: OpenConnector panel toggles alongside Chat and Knowledge
The web UI SHALL provide an "OpenConnector" panel activated via the left sidebar navigation tab (governed by the `app-navigation` capability), replacing the former header toggle button. Selecting the OpenConnector tab SHALL show the OpenConnector panel and hide all other panels. When the panel is opened, the UI SHALL fetch `GET /api/openconnector/config` and `GET /api/openconnector/health` to determine whether the module is enabled and whether the runtime is reachable, and SHALL display that status to the user. The OpenConnector tab SHALL additionally host the embedded native web UI (governed by the `open-connector-web` capability) alongside the existing action-browse/execute panel.

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
- **AND** the embedded native web UI SHALL be available as a management sub-view within the tab
