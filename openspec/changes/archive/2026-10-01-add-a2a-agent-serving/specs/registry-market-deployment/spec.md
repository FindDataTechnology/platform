## MODIFIED Requirements

### Requirement: Deployed market reflects registry content
With the wired configuration and a valid token, after the first registry refresh the production deployment's `GET /api/extensions/market` SHALL include the registry's enabled MCP servers and skills merged with (and name-colliding entries dropped in favor of) the bundled catalog, per the `extension-marketplace` specification. The Agents page SHALL list registry-sourced agents per the `agent-catalog` specification: `supported_protocol: "a2a"` entries as `a2a`-mode Agent Services (gateway route URL), others as link-mode agents.

#### Scenario: market API includes registry entries
- **WHEN** the deployed platform has refreshed from the registry at least once
- **THEN** `GET /api/extensions/market` SHALL return registry entries alongside bundled ones
- **AND** registry MCP entries SHALL carry a `configTemplate` pointing at the gateway endpoint `https://mcp.finddatatech.cloud/<name>/mcp`

#### Scenario: a2a agents surface as Agent Services
- **WHEN** the registry lists an enabled agent with `supported_protocol: "a2a"`
- **THEN** `GET /api/catalog` SHALL include it as an `a2a`-mode entry with the gateway route `https://mcp.finddatatech.cloud/agent/{path}/` as its `url`

#### Scenario: registry outage keeps the store usable
- **WHEN** the registry becomes unreachable after a successful refresh
- **THEN** the deployed market SHALL keep serving the last-good registry entries with the bundled catalog, per the existing degradation requirement
