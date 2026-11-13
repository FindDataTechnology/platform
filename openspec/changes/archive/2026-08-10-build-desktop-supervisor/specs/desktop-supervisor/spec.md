## ADDED Requirements

### Requirement: Server descriptor registry
The supervisor SHALL manage a registry of server descriptors. Each descriptor SHALL declare the server's id, runtime kind (`node` / `python` / `http-external`), start command, working directory, environment, transport (`http-port` or `stdio-rpc`), health-check probe, dependency list, and whether the server is optional.

#### Scenario: App launches with the four default servers
- **WHEN** the Electron app starts
- **THEN** the supervisor loads descriptors for `server.js`, `pi-agent`, `litellm`, and `openconnector`
- **AND** begins orchestrating them according to their declared dependencies

### Requirement: Ordered startup with dependency readiness
The supervisor SHALL start servers in dependency order and SHALL wait for each server's health check to pass before starting servers that depend on it.

#### Scenario: pi-agent starts before server.js
- **WHEN** the app starts
- **THEN** the supervisor starts `pi-agent` and waits for its RPC health check to pass
- **BEFORE** starting `server.js`, which declares `pi-agent` as a dependency

#### Scenario: external servers are health-checked, not spawned
- **WHEN** `litellm` and `openconnector` are configured as `http-external` (URLs only)
- **THEN** the supervisor polls their health endpoints
- **AND** does NOT spawn a process for them
- **AND** marks them green or red without blocking app launch when they are optional

### Requirement: Health checking per transport
The supervisor SHALL health-check each running server on an interval using a transport-appropriate probe: an HTTP `GET` for `http-port` / `http-external` servers, and a correlated RPC request for `stdio-rpc` servers.

#### Scenario: HTTP server health
- **WHEN** `server.js` is running on its assigned port
- **THEN** the supervisor periodically issues an HTTP health request and marks it healthy on a 2xx response

#### Scenario: stdio RPC server health
- **WHEN** `pi-agent` is running behind its stdio bridge
- **THEN** the supervisor sends an RPC request with a correlation id and marks it healthy when the matching response is received

### Requirement: Automatic restart on unexpected failure
The supervisor SHALL restart a server process if it exits unexpectedly, subject to a backoff policy, and SHALL NOT restart a server that exited because the app is shutting down.

#### Scenario: agent crash self-heals
- **WHEN** the `pi-agent` process crashes unexpectedly
- **THEN** the supervisor restarts it after a backoff delay
- **AND** the window and `server.js` remain unaffected

#### Scenario: no restart during shutdown
- **WHEN** the user quits the app
- **THEN** the supervisor stops all servers without triggering restart logic

### Requirement: Ordered shutdown
The supervisor SHALL stop servers in reverse dependency order on app quit, terminating each child process gracefully and then forcibly after a timeout.

#### Scenario: shutdown order
- **WHEN** the app quits
- **THEN** the supervisor closes the window, then stops `server.js`, then `pi-agent`, then any bundled sidecars, in reverse startup order

### Requirement: Status inspection
The supervisor SHALL expose the live status of every server - id, state, pid, assigned port, last health result, restart count, and recent log lines - for display in the app.

#### Scenario: inspect server status
- **WHEN** the UI requests supervisor status
- **THEN** the supervisor returns each server's current state and its recent log lines

### Requirement: Log capture
The supervisor SHALL capture each child process's stdout and stderr into a per-server ring buffer and SHALL surface them through the status inspection API.

#### Scenario: child stderr captured
- **WHEN** a child server writes to stderr
- **THEN** the supervisor appends it to that server's log ring buffer
- **AND** it is retrievable via status inspection

### Requirement: Graceful degradation of optional servers
The supervisor SHALL allow the app to launch and `server.js` to start even when optional servers (`litellm`, `openconnector`) are unreachable or unconfigured, preserving the existing graceful-degradation contract.

#### Scenario: OpenConnector unreachable
- **WHEN** `openconnector` is enabled in settings but its health check fails
- **THEN** the supervisor marks it red
- **AND** `server.js` starts and hides the OpenConnector panel, as it does today

### Requirement: Port management for spawned servers
The supervisor SHALL assign a free localhost port to each spawned port-speaking server at launch and SHALL pass the resolved URLs of sibling servers into each child's environment.

#### Scenario: server.js receives sibling URLs
- **WHEN** the supervisor starts `server.js`
- **THEN** it passes `LITELLM_BASE_URL`, `OPENCONNECTOR_BASE_URL`, and the pi-agent RPC bridge URL into `server.js`'s environment
