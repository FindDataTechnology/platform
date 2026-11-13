## MODIFIED Requirements

### Requirement: Local spawn with per-service external-URL override
For each of LiteLLM and OpenConnector independently, the launcher SHALL spawn the bundled service locally when the component is selected in the resolved bundle manifest AND its bundled resources are present on disk AND its `*_BASE_URL` is either unset OR a localhost URL (`localhost` / `127.0.0.1` / `::1`). When the `*_BASE_URL` is a localhost URL with an explicit port, the launcher SHALL spawn the service on that port; when unset, on a free localhost port. When the `*_BASE_URL` is a non-localhost (external) URL, the launcher SHALL NOT spawn that service and SHALL pass the URL through to `server.js` unchanged. A component excluded from the bundle manifest SHALL be treated as if its bundled resources were absent (external URLs still apply). The bundled-vs-external resolution SHALL reuse the desktop supervisor's descriptor resolution.

#### Scenario: localhost URL spawns the bundled service on that port
- **WHEN** bundled LiteLLM resources are present, the manifest selects litellm, and `LITELLM_BASE_URL=http://localhost:4000`
- **THEN** the launcher spawns the bundled LiteLLM on port 4000
- **AND** injects `LITELLM_BASE_URL=http://localhost:4000` into `server.js`'s env
- **AND** does not contact any remote server

#### Scenario: both services spawned locally
- **WHEN** bundled LiteLLM and OpenConnector resources are present, the manifest selects both, and neither `LITELLM_BASE_URL` nor `OPENCONNECTOR_BASE_URL` is set
- **THEN** the launcher spawns both services on distinct free localhost ports
- **AND** does not contact any remote server for either service

#### Scenario: external URL wins for one service
- **WHEN** bundled resources for both services are present
- **AND** `LITELLM_BASE_URL=https://litellm.example.com` is set but `OPENCONNECTOR_BASE_URL` is unset
- **THEN** the launcher spawns OpenConnector locally and does NOT spawn LiteLLM
- **AND** injects the external LiteLLM URL into `server.js`'s env unchanged

#### Scenario: external URL wins for both services
- **WHEN** both `LITELLM_BASE_URL` and `OPENCONNECTOR_BASE_URL` are set to external (non-localhost) URLs
- **THEN** the launcher spawns neither service locally
- **AND** health-checks each external URL without spawning a process, as the desktop supervisor does today

#### Scenario: manifest-deselected service does not spawn
- **WHEN** the manifest excludes OpenConnector and bundled OpenConnector resources are present and `OPENCONNECTOR_BASE_URL` is unset
- **THEN** the launcher SHALL NOT spawn OpenConnector
- **AND** reports it as excluded (not merely absent) in the startup summary
