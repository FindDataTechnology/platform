# registry-market-deployment 接线校正

## MODIFIED Requirements

### Requirement: Deployment wires the registry market source

The platform production deployment SHALL provide the unified supply catalog read path: `FACET_CATALOG_URL` (facet catalog base URL) and `FACET_CATALOG_TOKEN` (facet internal credential for the global read). The legacy direct-registry wiring `REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` remains **required for the agents leg** — the registry's `/api/agents` face feeds the cell catalog, fleet posts and room summoning, and is fetched with those credentials even when the facet catalog supplies the mcp/skill species (`registry-bridge.js:571-580`) — and serves as the documented rollback for the whole source. When both are configured the facet catalog SHALL win for the mcp/skill species; the legacy direct feed for those species is deprecated, and `initRegistryBridge` SHALL announce it at boot with a warning (source selection itself lives in `getCatalogSource`, which only picks). In the live layout (namespace `fd-prod`, env injected via `envFrom`) the URLs live in the `platform-config` ConfigMap and the tokens as Secret keys; token values SHALL NOT be committed to the repository in plaintext. With no catalog source configured the market SHALL serve its offline floor: the app-shipped starter floor plus the generated snapshot (`market-catalog.json` / `market-catalog-skills.json`). A third gate below this one — the facet's own `SUPPLY_STORE_CATALOG` switch between the spine store and its registry bridge — is internal to the facet deployment and outside this capability.

#### Scenario: deployment carries registry URL and token

- **WHEN** the production deployment is running with the wired configuration
- **THEN** the platform process SHALL run with a non-empty `FACET_CATALOG_URL` and `FACET_CATALOG_TOKEN`
- **AND** the legacy `REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` SHALL remain configured — unsetting `FACET_CATALOG_URL` falls back to the direct feed for every species, and even with it set the agents leg still reads the registry

#### Scenario: missing token does not block startup

- **WHEN** the facet catalog token key is absent or expired
- **THEN** the platform SHALL still start and serve the catalog's public projection subset (or the offline starter floor plus generated snapshot when no source is reachable)
- **AND** registry-sourced entries requiring the credential SHALL be absent until a valid token is provided

### Requirement: Deployed market reflects registry content

With the wired configuration and a valid token, after the first refresh the production deployment's `GET /api/extensions/market` SHALL include the registry's (or facet catalog's) enabled MCP servers and skills assembled with the app-shipped starter floor, per the `extension-marketplace` specification. Assembly is catalog-wins, not bundled-wins: a catalog entry sharing a starter entry's name removes the starter entry (`extension-store.js:194-196,209-214`), because the supply plane is the truth for what a server is; the floor and the catalog are disjoint by construction (stdio vs gateway). The Agents page SHALL list registry-sourced agents per the `agent-catalog` specification: `supported_protocol: "a2a"` entries as `a2a`-mode Agent Services (gateway route URL), others as link-mode agents.

#### Scenario: market API includes registry entries

- **WHEN** the deployed platform has refreshed from its catalog source at least once
- **THEN** `GET /api/extensions/market` SHALL return catalog entries alongside the starter floor
- **AND** registry MCP entries SHALL carry a `configTemplate` whose URL is built from the configured gateway base plus the server name (`<base>/<name>/mcp`), or the endpoint the facet catalog supplied for that entry — never a hardcoded host

#### Scenario: a2a agents surface as Agent Services

- **WHEN** the registry lists an enabled agent with `supported_protocol: "a2a"`
- **THEN** `GET /api/catalog` SHALL include it as an `a2a`-mode entry with the registry gateway's agent route (`<gateway base>/agent/{path}/`) as its `url`

#### Scenario: registry outage keeps the store usable

- **WHEN** the catalog source becomes unreachable after a successful refresh
- **THEN** the deployed market SHALL keep serving the last-good catalog entries with the starter floor, per the existing degradation requirement

### Requirement: Operator runbook documents token provisioning

`DEPLOY.md` SHALL document how to obtain the credentials and wire them: the facet catalog pair (`FACET_CATALOG_URL`, `FACET_CATALOG_TOKEN`) for the unified read path, and the registry service token (registry admin UI's token issuance) stored in the `platform-secrets` Secret as `market-registry-token` for the agents leg and the rollback. It SHALL document restarting the platform deployment and verifying the wiring by checking `GET /api/extensions/market` for catalog entries and the boot log against the lines the code actually emits: `no catalog source; market serves the starter floor + generated snapshot` when nothing is wired, and the deprecation warning when only the legacy feed is. The runbook SHALL NOT point an operator at a log string the code no longer emits.

#### Scenario: operator follows the runbook end to end

- **WHEN** an operator obtains the credentials, updates the Secret and env, and restarts the deployment following `DEPLOY.md`
- **THEN** the restarted platform SHALL fetch catalog content on boot
- **AND** the market API and Store SHALL show catalog MCP servers and skills, and the Agents page the registry's agents, within one refresh cycle
