## Purpose

生产部署接线 registry 市场数据源：manifest 与 Secret 提供启用 `extension-marketplace` registry 合并所需的连接配置，使线上 Store 与 Agents 目录呈现 mcp-gateway-registry 上注册的业务内容，并给出可复核的部署后验证口径。

## ADDED Requirements

### Requirement: Deployment wires the registry market source
The platform production deployment SHALL provide `REGISTRY_URL` (registry base URL) and `MARKET_REGISTRY_TOKEN` (bearer token for the registry API) to the server process. In the live layout (namespace `fd-prod`, env injected via `envFrom`) the URL lives in the `platform-config` ConfigMap and the token as a `platform-secrets` Secret key; the repo manifest (`k8s/deployment.yaml`, pre-Harbor single-container layout) SHALL carry the equivalent `env` entries with the token sourced from a Secret key. The token value SHALL NOT be committed to the repository in plaintext.

#### Scenario: deployment carries registry URL and token
- **WHEN** the production deployment is running with the wired configuration
- **THEN** the platform process SHALL run with `REGISTRY_URL=https://mcp.finddatatech.cloud` and a non-empty `MARKET_REGISTRY_TOKEN`

#### Scenario: missing token does not block startup
- **WHEN** the token key is absent or expired
- **THEN** the platform SHALL still start and serve the bundled market catalog
- **AND** registry-sourced entries SHALL be absent (or degrade to last-good) until a valid token is provided

### Requirement: Deployed market reflects registry content
With the wired configuration and a valid token, after the first registry refresh the production deployment's `GET /api/extensions/market` SHALL include the registry's enabled MCP servers and skills merged with (and name-colliding entries dropped in favor of) the bundled catalog, per the `extension-marketplace` specification. The Agents page SHALL list registry-sourced link-mode agents per the `agent-catalog` specification.

#### Scenario: market API includes registry entries
- **WHEN** the deployed platform has refreshed from the registry at least once
- **THEN** `GET /api/extensions/market` SHALL return registry entries alongside bundled ones
- **AND** registry MCP entries SHALL carry a `configTemplate` pointing at the gateway endpoint `https://mcp.finddatatech.cloud/<name>/mcp`

#### Scenario: registry outage keeps the store usable
- **WHEN** the registry becomes unreachable after a successful refresh
- **THEN** the deployed market SHALL keep serving the last-good registry entries with the bundled catalog, per the existing degradation requirement

### Requirement: Operator runbook documents token provisioning
`DEPLOY.md` SHALL document how to obtain a registry service token (registry admin UI's token issuance), store it in the `platform-secrets` Secret as `market-registry-token`, restart the platform deployment, and verify the wiring by checking `GET /api/extensions/market` for registry entries and the boot log for the absence of the "registry source disabled" notice.

#### Scenario: operator follows the runbook end to end
- **WHEN** an operator creates the token, updates the Secret, and restarts the deployment following `DEPLOY.md`
- **THEN** the restarted platform SHALL fetch registry content on boot
- **AND** the market API and Store SHALL show registry MCP servers, skills, and agents within one refresh cycle
