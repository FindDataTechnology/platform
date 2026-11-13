# registry-market-deployment 接线改写

## MODIFIED Requirements

### Requirement: Deployment wires the registry market source
The platform production deployment SHALL provide the unified supply catalog read path: `FACET_CATALOG_URL` (facet catalog base URL) and `FACET_CATALOG_TOKEN` (facet internal credential for the global read), plus the legacy direct-registry wiring `REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` as the documented rollback. When both are configured the facet catalog SHALL win; the direct feed stays available only during the deprecation window and SHALL announce itself with a loud warning (`registry-bridge.js` `getCatalogSource`). In the live layout (namespace `fd-prod`, env injected via `envFrom`) the URLs live in the `platform-config` ConfigMap and the tokens as Secret keys; token values SHALL NOT be committed to the repository in plaintext. With no catalog source configured the market SHALL serve the bundled catalog (honest offline floor).

#### Scenario: deployment carries registry URL and token
- **WHEN** the production deployment is running with the wired configuration
- **THEN** the platform process SHALL run with a non-empty `FACET_CATALOG_URL` and `FACET_CATALOG_TOKEN`
- **AND** the legacy `REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` SHALL remain configured as the rollback (unsetting `FACET_CATALOG_URL` falls back to the direct feed)

#### Scenario: missing token does not block startup
- **WHEN** the facet catalog token key is absent or expired
- **THEN** the platform SHALL still start and serve the catalog's public projection subset (or the bundled market catalog when no source is reachable)
- **AND** registry-sourced entries requiring the credential SHALL be absent until a valid token is provided
