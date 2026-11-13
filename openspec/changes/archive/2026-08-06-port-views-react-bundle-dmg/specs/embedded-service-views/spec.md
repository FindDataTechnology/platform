## ADDED Requirements

### Requirement: OpenConnector view embeds the native runtime UI

The React OpenConnector view at `/openconnector` SHALL render the OpenConnector runtime's native management UI inside an `<iframe>` sourced from the existing same-origin `/oc-web` reverse proxy. It SHALL NOT reimplement the runtime's UI. The iframe SHALL fill the main content area below the sidebar.

#### Scenario: OpenConnector iframe loads when enabled
- **WHEN** the user navigates to `/openconnector`
- **AND** `/api/config` reports `openconnectorEnabled: true`
- **THEN** the view SHALL render an `<iframe src="/oc-web">` filling the main area
- **AND** the iframe SHALL load the runtime's native management UI via the token-injecting proxy

#### Scenario: OpenConnector disabled shows placeholder
- **WHEN** the user navigates to `/openconnector`
- **AND** `/api/config` reports `openconnectorEnabled: false`
- **THEN** the view SHALL render a "OpenConnector not configured" placeholder
- **AND** SHALL NOT render the iframe

#### Scenario: Tokens never reach the React renderer
- **WHEN** the OpenConnector view renders
- **THEN** no `OPENCONNECTOR_RUNTIME_TOKEN` or `OPENCONNECTOR_ADMIN_TOKEN` value SHALL appear in the React DOM, props, or network responses to the browser
- **AND** the iframe's `/oc-web` request SHALL be authenticated server-side by the proxy

### Requirement: LiteLLM view embeds the native admin UI

The React LiteLLM view at `/litellm` SHALL render the LiteLLM admin UI inside an `<iframe>`. When the admin UI is on a different origin, the server SHALL provide a same-origin `/litellm-web` reverse proxy (mirroring the `/oc-web` pattern) that injects the admin token and rewrites frame-ancestors so the iframe can render. If framing is blocked by the upstream UI, the view SHALL fall back to an "Open in new tab" link.

#### Scenario: LiteLLM iframe loads when enabled
- **WHEN** the user navigates to `/litellm`
- **AND** `/api/config` reports `litellmEnabled: true`
- **THEN** the view SHALL render an `<iframe>` filling the main area pointed at the LiteLLM admin UI (via `/litellm-web` proxy or the configured URL)

#### Scenario: LiteLLM disabled shows placeholder
- **WHEN** the user navigates to `/litellm`
- **AND** `/api/config` reports `litellmEnabled: false`
- **THEN** the view SHALL render a "LiteLLM not configured" placeholder
- **AND** SHALL NOT render the iframe

#### Scenario: Framing blocked falls back to link
- **WHEN** the LiteLLM admin UI refuses to be framed (X-Frame-Options or CSP frame-ancestors)
- **THEN** the view SHALL detect the blocked load and render an "Open LiteLLM in a new tab" link
- **AND** the link SHALL open the admin URL in a new browser tab

#### Scenario: LiteLLM master key never reaches the renderer
- **WHEN** the LiteLLM view renders
- **THEN** no `LITELLM_API_KEY` value SHALL appear in the React DOM or be sent to the browser
- **AND** the `/litellm-web` proxy SHALL inject the admin token server-side

### Requirement: Embedded service views share the app shell

The OpenConnector and LiteLLM iframe views SHALL render inside the same app shell as the other React views (sidebar remains visible, WebSocket stays connected). Navigating away from an embedded view SHALL NOT require a page reload.

#### Scenario: Navigation between embedded view and chat
- **WHEN** the user is on `/openconnector` and clicks Chat in the sidebar
- **THEN** the React router SHALL switch to `/chat` without a full page reload
- **AND** the WebSocket connection SHALL remain open
