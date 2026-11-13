## ADDED Requirements

### Requirement: Server reverse-proxies the OpenConnector runtime web UI with token injection
When the OpenConnector module is enabled, the server SHALL mount a reverse proxy that forwards requests under the `/oc-web` path (and sub-paths) to the configured OpenConnector runtime, forwarding the request method, body, and query string. The proxy SHALL authenticate to the runtime using the server-held token selected by path family: the admin token for the UI shell and `/api/*` paths, the runtime token for `/v1/*` and `/mcp` paths. The proxy SHALL NOT forward any `Authorization` header or token-like field supplied by the browser. The proxy SHALL constrain upstream requests to the configured runtime base URL. Because the embedded UI is a Vite SPA that issues same-origin absolute requests for its assets and runtime API, the server SHALL additionally proxy the SPA's absolute path roots (`/assets/*`, `/v1/*`, and a `/api/*` catch-all) at the server root; the `/api/*` catch-all SHALL be registered after the application's own `/api/*` routes so those take precedence.

#### Scenario: browser loads the embedded UI without a token
- **WHEN** the browser requests `GET /oc-web`
- **THEN** the server SHALL proxy the request to the runtime root using the server-held admin token
- **AND** SHALL return the runtime's HTML response to the browser
- **AND** SHALL NOT include any token value in the response sent to the browser

#### Scenario: client attempts to override the token
- **WHEN** a client sends an `Authorization` header to `/oc-web/*`
- **THEN** the server SHALL ignore it and authenticate to the runtime using only the server-held token

#### Scenario: SPA asset request is proxied at the root
- **WHEN** the embedded UI requests an absolute asset path such as `/assets/index-*.js`
- **THEN** the server SHALL proxy it to the runtime `/assets/...` and return the asset

#### Scenario: app's own API routes take precedence over the catch-all
- **WHEN** the browser requests `/api/documents` or `/api/openconnector/health`
- **THEN** the server SHALL route it to the application's own handler (not the runtime proxy)
- **AND** when the browser requests a runtime admin path such as `/api/connections` the server SHALL proxy it to the runtime with the admin token

### Requirement: OpenConnector tab renders the proxied UI in a same-origin frame
The OpenConnector tab SHALL render the proxied runtime UI inside an `<iframe>` whose `src` points at the server's `/oc-web` proxy path (same-origin), so the browser never contacts the runtime URL directly. The frame SHALL fill the tab's content area.

#### Scenario: opening the OpenConnector management view
- **WHEN** the user opens the OpenConnector tab and selects the management sub-view
- **THEN** the UI SHALL render an iframe with `src="/oc-web"`
- **AND** the iframe SHALL be same-origin with the app
- **AND** no request SHALL be sent to the runtime base URL directly from the browser

### Requirement: Proxy degrades gracefully when the module is disabled or runtime unreachable
When the OpenConnector module is disabled, the server SHALL NOT mount the `/oc-web` proxy and the OpenConnector tab SHALL show a disabled state. When the module is enabled but the runtime is unreachable, the proxy SHALL surface a clear error without crashing the server.

#### Scenario: module disabled
- **WHEN** `OPENCONNECTOR_BASE_URL` is unset
- **THEN** the server SHALL start without mounting `/oc-web`
- **AND** the OpenConnector tab SHALL show that the module is disabled

#### Scenario: runtime unreachable during a proxied request
- **WHEN** the runtime is unreachable while proxying a `/oc-web` request
- **THEN** the server SHALL return an error response to the browser
- **AND** SHALL NOT crash or abort other requests
