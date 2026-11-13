## MODIFIED Requirements

### Requirement: Port management for spawned servers
The supervisor SHALL assign a free localhost port to each spawned port-speaking server at launch and SHALL pass the resolved URLs of sibling servers into each child's environment. When a fixed port is configured for `server-js` (`DESKTOP_SERVER_PORT`, set by the packaged app so the Logto redirect URI stays registerable), the supervisor SHALL use that port exclusively: if it cannot bind, startup SHALL fail with a visible error rather than silently falling back to a random port. The packaged app SHALL inject the auth configuration (`AUTH_MODE=logto`, `LOGTO_ENDPOINT`, the public `LOGTO_APP_ID`, `LOGTO_CLIENT_TYPE=public`, `SESSION_TTL_HRS=720`) into the `server-js` child environment from its bundled settings file.

#### Scenario: server.js receives a dynamic free port
- **WHEN** the supervisor starts `server.js` without a fixed port configured
- **THEN** it selects a free localhost port and passes it into the child's environment
- **AND** the Electron window loads `http://localhost:<port>` once the health check passes

#### Scenario: fixed port is used exclusively
- **WHEN** `DESKTOP_SERVER_PORT=47600` is set
- **THEN** `server.js` binds `127.0.0.1:47600` and the window loads that port

#### Scenario: fixed-port conflict surfaces a visible error
- **WHEN** the fixed port is already taken by another process
- **THEN** the supervisor fails startup with the existing backend-error window instead of silently using a random port

#### Scenario: auth environment injected from bundled settings
- **WHEN** the packaged app starts
- **THEN** the `server.js` child receives the logto public-client auth configuration from the bundled settings file
- **AND** local development without a settings file behaves as before (random port, no auth env)
