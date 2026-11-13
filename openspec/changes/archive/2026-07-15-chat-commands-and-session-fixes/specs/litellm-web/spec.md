## ADDED Requirements

### Requirement: Server reverse-proxies the LiteLLM management UI with token injection
When LiteLLM is configured (`LITELLM_BASE_URL` and `LITELLM_API_KEY` set), the server SHALL mount a reverse proxy that forwards requests under the `/litellm-web` path (and sub-paths) to the configured LiteLLM base URL, forwarding the request method, body, and query string. The proxy SHALL authenticate to LiteLLM using the server-held `LITELLM_API_KEY` as a bearer token. The proxy SHALL NOT forward any `Authorization` header or token-like field supplied by the browser. The proxy SHALL constrain upstream requests to the configured LiteLLM base URL and SHALL inject a `<base href="/litellm-web/">` tag into HTML responses so relative assets resolve under the proxy prefix. Content-encoding and content-length SHALL NOT be forwarded (Node's fetch decompresses the body; express recomputes length).

#### Scenario: browser loads the embedded UI without a token
- **WHEN** the browser requests `GET /litellm-web`
- **THEN** the server SHALL proxy the request to the LiteLLM base URL using the server-held API key
- **AND** SHALL return LiteLLM's HTML response to the browser
- **AND** SHALL NOT include any token value in the response sent to the browser

#### Scenario: client attempts to override the token
- **WHEN** a client sends an `Authorization` header to `/litellm-web/*`
- **THEN** the server SHALL ignore it and authenticate to LiteLLM using only the server-held API key

### Requirement: LiteLLM SPA absolute API paths are proxied at the root
Because the LiteLLM management UI is a SPA that issues same-origin absolute requests for its API, the server SHALL proxy the SPA's non-conflicting admin roots (`/key/*`, `/spend/*`, `/model/*`) at the server root to the LiteLLM base URL whenever LiteLLM is configured, and the contested roots (`/v1/*` and a `/api/*` catch-all) ONLY when the OpenConnector module is not enabled (OpenConnector owns `/v1/*` and `/api/*` when it is enabled). The `/api/*` catch-all SHALL be registered after the application's own `/api/*` routes so those take precedence.

#### Scenario: non-conflicting admin root proxied whenever LiteLLM is configured
- **WHEN** the embedded LiteLLM UI requests an absolute admin path such as `/key/info` or `/model/info`
- **THEN** the server SHALL proxy it to the LiteLLM base URL, whether or not OpenConnector is enabled

#### Scenario: contested root proxied only when OpenConnector is disabled
- **WHEN** the embedded LiteLLM UI requests `/v1/models` and OpenConnector is disabled
- **THEN** the server SHALL proxy it to the LiteLLM base URL

#### Scenario: contested root not proxied when OpenConnector is enabled
- **WHEN** the embedded LiteLLM UI requests `/v1/models` and OpenConnector is enabled
- **THEN** the server SHALL NOT route it to LiteLLM (it is owned by OpenConnector)
- **AND** the LiteLLM view SHALL surface a fallback link to open the management UI in a new tab

#### Scenario: app's own API routes take precedence over the catch-all
- **WHEN** the browser requests `/api/documents` or `/api/config`
- **THEN** the server SHALL route it to the application's own handler, not the LiteLLM proxy

### Requirement: LiteLLM view renders the proxied UI in a same-origin frame
The LiteLLM sidebar entry SHALL switch the main content area to a LiteLLM view that renders the proxied management UI inside an `<iframe>` whose `src` points at the server's `/litellm-web` proxy path (same-origin), so the browser never contacts the LiteLLM base URL directly. The frame SHALL fill the view's content area.

#### Scenario: opening the LiteLLM view
- **WHEN** the user activates the LiteLLM sidebar entry and LiteLLM is configured
- **THEN** the UI SHALL render an iframe with `src="/litellm-web"`
- **AND** the iframe SHALL be same-origin with the app
- **AND** no request SHALL be sent to the LiteLLM base URL directly from the browser

### Requirement: LiteLLM web proxy degrades gracefully
When LiteLLM is not configured, the server SHALL NOT mount the `/litellm-web` proxy and the LiteLLM sidebar entry SHALL be absent. When LiteLLM is configured but unreachable, the proxy SHALL surface a clear error without crashing the server.

#### Scenario: LiteLLM not configured
- **WHEN** `LITELLM_BASE_URL` or `LITELLM_API_KEY` is unset
- **THEN** the server SHALL start without mounting `/litellm-web`
- **AND** the LiteLLM sidebar entry SHALL NOT be rendered

#### Scenario: LiteLLM unreachable during a proxied request
- **WHEN** LiteLLM is unreachable while proxying a `/litellm-web` request
- **THEN** the server SHALL return an error response to the browser
- **AND** SHALL NOT crash or abort other requests
