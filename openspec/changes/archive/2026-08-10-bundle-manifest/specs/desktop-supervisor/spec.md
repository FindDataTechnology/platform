## ADDED Requirements

### Requirement: Manifest-gated bundled service descriptors
The supervisor SHALL generate a bundled-spawn descriptor for LiteLLM, OpenConnector, or Postgres only when the component is both selected in the resolved bundle manifest AND its bundled resources are present on disk AND no external URL (`*_BASE_URL` / `DATABASE_URL`) overrides it. A component excluded from the manifest SHALL be treated exactly as if its bundled resources were absent, falling through to the external-URL descriptor path (enabled only when an external URL is configured). External-URL operation SHALL remain available regardless of manifest selection.

#### Scenario: deselected component does not spawn
- **WHEN** the bundle manifest excludes OpenConnector and bundled OpenConnector resources exist on disk
- **THEN** the supervisor SHALL NOT spawn OpenConnector
- **AND** the OpenConnector descriptor resolves to disabled unless `OPENCONNECTOR_BASE_URL` is an external URL

#### Scenario: external URL still works for a deselected component
- **WHEN** the bundle manifest excludes LiteLLM and `LITELLM_BASE_URL=https://litellm.example.com` is set
- **THEN** the supervisor SHALL health-check the external LiteLLM URL without spawning any local process

#### Scenario: selected component with resources spawns as before
- **WHEN** the bundle manifest selects LiteLLM, bundled resources are present, and no external URL is set
- **THEN** the supervisor spawns the bundled LiteLLM exactly as it does today
