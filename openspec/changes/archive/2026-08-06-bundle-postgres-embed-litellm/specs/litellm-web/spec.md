## REMOVED Requirements

### Requirement: LiteLLM view links to the management UI in a new tab
**Reason**: The LiteLLM admin dashboard is now functional (a bundled Postgres DB + Prisma + `LITELLM_MASTER_KEY` initialize it), so it can be embedded in-page via the `/litellm-web` proxy. The open-in-new-tab link is no longer the primary action.
**Migration**: The LiteLLM view renders the dashboard in a same-origin `<iframe src="/litellm-web/ui">` (see the new "LiteLLM dashboard embedded in-page" requirement). The `target="_blank"` link is removed.

## ADDED Requirements

### Requirement: LiteLLM dashboard is embedded in-page via the /litellm-web proxy
The LiteLLM view SHALL render the LiteLLM management dashboard inside a same-origin `<iframe>` whose `src` points at the server's `/litellm-web/ui` proxy path. The server SHALL proxy `/ui/*` (the dashboard's Next.js SPA assets) to the LiteLLM base URL with the server-held `LITELLM_API_KEY` as bearer, and SHALL exclude `/ui/` from the SPA fallback so those requests reach the proxy. The dashboard's admin API roots (`/key/*`, `/spend/*`, `/model/*`) SHALL continue to be proxied to LiteLLM. The dashboard's `/v1/*` and `/api/*` calls are owned by OpenConnector when it is enabled (known limitation); model management SHALL go through `STORE_MODEL_IN_DB` + the DB. The `LITELLM_API_KEY` SHALL NOT be exposed to the browser. When LiteLLM is not configured or the DB is not initialized, the view SHALL show a disabled placeholder. No `target="_blank"` new-tab link SHALL be the primary action.

#### Scenario: embedded dashboard loads when configured
- **WHEN** the user opens the LiteLLM view and LiteLLM is configured with a healthy DB
- **THEN** the view SHALL render an iframe with `src="/litellm-web/ui"`
- **AND** the iframe SHALL be same-origin with the app
- **AND** the dashboard's `/ui/_next/*` assets SHALL load via the `/ui/*` proxy

#### Scenario: dashboard admin API roots proxied
- **WHEN** the embedded dashboard requests `/key/info` or `/model/info`
- **THEN** the server SHALL proxy it to the LiteLLM base URL with the server-held key
- **AND** SHALL NOT expose the key to the browser

#### Scenario: LiteLLM not configured or DB not ready
- **WHEN** the user opens the LiteLLM view and LiteLLM is not configured or the DB is not initialized
- **THEN** the view SHALL show a disabled placeholder
- **AND** SHALL NOT render the iframe
