## REMOVED Requirements

### Requirement: LiteLLM view renders the proxied UI in a same-origin frame
**Reason**: The LiteLLM management dashboard is a Next.js SPA built with basePath `/ui` and an interactive sign-in flow. Embedding it same-origin via the `/litellm-web` proxy is unreliable: the dashboard hard-redirects to `/ui/*` (its basePath), and its login flow cannot be satisfied by the server-side token-injecting proxy. The view now links to the management UI in a new tab instead.
**Migration**: The `/litellm-web` reverse proxy and its admin-root proxies (`/key/*`, `/spend/*`, `/model/*`) remain mounted, but the LiteLLM view no longer embeds an iframe. It renders an open-in-new-tab link to `litellmManagementUrl`.

## ADDED Requirements

### Requirement: LiteLLM view links to the management UI in a new tab
The LiteLLM sidebar entry SHALL switch the main content area to a LiteLLM view that presents a link to open the LiteLLM management dashboard (`litellmManagementUrl`) in a new browser tab. Because the dashboard is a Next.js SPA with its own basePath (`/ui`) and an interactive sign-in flow that the server-side token-injecting proxy cannot satisfy, it is opened natively rather than embedded in a same-origin iframe. The link SHALL use `target="_blank"` and `rel="noopener noreferrer"`. The server-held `LITELLM_API_KEY` SHALL NOT be exposed to the browser. When LiteLLM is not configured or `litellmManagementUrl` is absent, the view SHALL show the disabled placeholder instead of the link.

#### Scenario: opening the LiteLLM view when configured
- **WHEN** the user activates the LiteLLM sidebar entry and LiteLLM is configured
- **THEN** the UI SHALL render a link whose `href` is `litellmManagementUrl`
- **AND** the link SHALL open in a new tab (`target="_blank"`)
- **AND** no iframe SHALL be embedded for the LiteLLM dashboard

#### Scenario: LiteLLM not configured
- **WHEN** the user activates the LiteLLM sidebar entry and LiteLLM is not configured
- **THEN** the UI SHALL show the disabled placeholder
- **AND** SHALL NOT render the open-in-new-tab link

### Requirement: Server exposes LiteLLM-enabled state to the client
The server SHALL include a boolean `litellmEnabled` field in the `/api/config` JSON response indicating whether LiteLLM is configured (`LITELLM_BASE_URL` and `LITELLM_API_KEY` both set). The server SHALL also include `litellmManagementUrl` (the LiteLLM management UI URL, `${LITELLM_BASE_URL}/ui`) when LiteLLM is configured, and `null` otherwise. The client SHALL use `litellmEnabled` to decide whether to render the LiteLLM sidebar entry and view.

#### Scenario: LiteLLM configured
- **WHEN** the client requests `/api/config` and LiteLLM is configured
- **THEN** the response SHALL include `litellmEnabled: true` and a non-null `litellmManagementUrl`

#### Scenario: LiteLLM not configured
- **WHEN** the client requests `/api/config` and LiteLLM is not configured
- **THEN** the response SHALL include `litellmEnabled: false` and `litellmManagementUrl: null`
