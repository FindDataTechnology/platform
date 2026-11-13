## ADDED Requirements

### Requirement: Server surfaces a reachable LiteLLM API base URL for direct API use
When LiteLLM is configured and running locally (`LITELLM_BASE_URL` points at `localhost` or `127.0.0.1`), the server SHALL include the live `LITELLM_BASE_URL` - the actually-running proxy's base, including its dynamic port - as `apiBaseUrl` in the `/api/litellm/credentials` JSON response, alongside the `masterKey`. The `apiBaseUrl` SHALL reflect the proxy the server is currently configured against (not a stale `.env` value), so a client can call `${apiBaseUrl}/v1/...` authenticated with the bearer `masterKey`. The base URL is not a secret and is already derivable from `litellmManagementUrl`; the `masterKey` SHALL continue to be gated on the local-proxy condition. When LiteLLM is configured against a non-local (remote) URL, `apiBaseUrl` SHALL be `null` and `masterKey` SHALL remain `null` (no key or reachable-local-URL is surfaced).

#### Scenario: local LiteLLM exposes the API base URL
- **WHEN** the client requests `/api/litellm/credentials` and LiteLLM is configured against a local URL
- **THEN** the response SHALL include `apiBaseUrl` set to the live `LITELLM_BASE_URL` including the dynamic port
- **AND** SHALL include `masterKey` set to the server-held `LITELLM_API_KEY`

#### Scenario: remote LiteLLM does not expose the API base URL or key
- **WHEN** the client requests `/api/litellm/credentials` and LiteLLM is configured against a non-local URL
- **THEN** the response SHALL include `apiBaseUrl: null` and `masterKey: null`

### Requirement: LiteLLM view displays the API base URL and master key
The LiteLLM view SHALL display the `apiBaseUrl` and `masterKey` (when non-null) as copyable fields alongside the open-in-new-tab management dashboard link, so the user can access the LiteLLM API directly. When both are null (remote proxy), the view SHALL show the sign-in hint without the copyable fields. The dashboard link SHALL continue to open `litellmManagementUrl` in a new tab; no iframe SHALL be embedded for the LiteLLM dashboard.

#### Scenario: local LiteLLM view shows the API URL and key
- **WHEN** the user opens the LiteLLM view and LiteLLM is configured against a local URL
- **THEN** the view SHALL render copyable `apiBaseUrl` and `masterKey` fields
- **AND** SHALL render the open-in-new-tab dashboard link to `litellmManagementUrl`

#### Scenario: remote LiteLLM view omits the copyable fields
- **WHEN** the user opens the LiteLLM view and LiteLLM is configured against a non-local URL
- **THEN** the view SHALL NOT render the copyable `apiBaseUrl`/`masterKey` fields
- **AND** SHALL render the dashboard link and a sign-in hint
