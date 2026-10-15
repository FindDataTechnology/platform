# desktop-supervisor Specification

## Purpose
Governs the Electron main process, which runs no application logic and instead supervises the backend as a child process. The shared, Electron-agnostic `supervisor/` package owns the orchestration: descriptor registry, startup with health readiness, health checking, automatic restart, ordered shutdown, status inspection, log capture, and port management.

## Requirements

### Requirement: Server descriptor registry
The supervisor SHALL manage a registry of server descriptors. Each descriptor SHALL declare the server's id, runtime kind (`node` / `http-external`), start command, working directory, environment, transport (`http-port` or `stdio-rpc`), health-check probe, dependency list, and whether the server is optional.

#### Scenario: App launches with the default servers
- **WHEN** the Electron app starts
- **THEN** the supervisor loads the `server-js` descriptor
- **AND** begins orchestrating it according to its declared dependencies

### Requirement: Startup waits for health readiness
The supervisor SHALL start servers in dependency order and SHALL wait for each server's health check to pass before starting servers that depend on it. The app window SHALL open only after the backend reports healthy.

#### Scenario: window opens only after the backend is healthy
- **WHEN** the app starts
- **THEN** the supervisor starts `server-js` and polls its health endpoint
- **AND** the `BrowserWindow` is created only once that health check passes

#### Scenario: dependents wait for their dependency
- **WHEN** a descriptor declares a dependency on another server
- **THEN** the supervisor SHALL NOT start it until the dependency's health check passes

### Requirement: Health checking per transport
The supervisor SHALL health-check each running server on an interval using a transport-appropriate probe: an HTTP `GET` for `http-port` / `http-external` servers, and a TCP connection for descriptors that declare a `tcp` health kind.

#### Scenario: HTTP server health
- **WHEN** `server.js` is running on its assigned port
- **THEN** the supervisor periodically issues an HTTP health request and marks it healthy on a 2xx response

#### Scenario: TCP server health
- **WHEN** a descriptor declares a `tcp` health kind
- **THEN** the supervisor marks it healthy when a TCP connection to its port succeeds

### Requirement: Automatic restart on unexpected failure
The supervisor SHALL restart a server process if it exits unexpectedly, subject to a backoff policy, and SHALL NOT restart a server that exited because the app is shutting down.

#### Scenario: crashed server self-heals
- **WHEN** a spawned server process exits unexpectedly
- **THEN** the supervisor restarts it after a backoff delay
- **AND** the window remains unaffected

#### Scenario: no restart during shutdown
- **WHEN** the user quits the app
- **THEN** the supervisor stops all servers without triggering restart logic

### Requirement: Ordered shutdown
The supervisor SHALL stop servers in reverse dependency order on app quit, terminating each child process gracefully and then forcibly after a timeout.

#### Scenario: shutdown order
- **WHEN** the app quits
- **THEN** the supervisor stops the spawned servers in reverse startup order, terminating each child process gracefully and then forcibly after a timeout

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

### Requirement: Health probes target the bound address
The supervisor MUST probe a server at the address that server actually bound, rather than at an independently hardcoded hostname.

#### Scenario: Probe follows the pinned bind address
- **WHEN** the injected child environment pins `HOST` to a concrete address (e.g. the desktop's `127.0.0.1`)
- **THEN** the health probe URL uses that same address
- **AND** a bind-family mismatch cannot present as healthy

#### Scenario: localhost-only bind no longer hides from the renderer
- **GIVEN** a host where `localhost` resolves to `::1` only
- **WHEN** the backend binds `localhost` while the renderer loads `127.0.0.1`
- **THEN** the probe—following the bind address—reflects what the renderer can reach
- **AND** a green probe implies the renderer's target is reachable

### Requirement: Desktop backend binds IPv4 loopback
On packaged desktop runs the backend MUST bind a concrete IPv4 loopback address instead of the hostname `localhost`.

#### Scenario: Packaged run binds 127.0.0.1
- **WHEN** the app is packaged
- **THEN** the seeded desktop settings include `HOST=127.0.0.1` for the spawned backend
- **AND** the backend listens on IPv4 loopback (verifiable by confirming an IPv4 listener on the desktop port)

#### Scenario: Dev and container runs keep their own binding
- **WHEN** running in dev or in a container
- **THEN** `HOST` remains caller-controlled (including `0.0.0.0` for container reachability)
- **AND** the desktop default does not override an explicit host

### Requirement: Main process logs to a user-readable file
The packaged main process MUST mirror its console output to a log file inside the user data directory.

#### Scenario: Packaged console output is persisted
- **WHEN** the app runs packaged (where no console exists)
- **THEN** every main-process log, warning and error is appended to a log file under the user data directory
- **AND** the application menu exposes an action that reveals that file

#### Scenario: Log failure never breaks the shell
- **WHEN** the log file cannot be written (read-only disk, full disk)
- **THEN** the failure is swallowed
- **AND** the application continues to boot

### Requirement: Window is revealed only after it paints
The main window MUST stay hidden until the renderer finishes loading, and MUST never leave the user with an unpainted window.

#### Scenario: Window shows after first successful load
- **WHEN** the window finishes loading its content
- **THEN** the window becomes visible
- **AND** an unpainted dark backdrop is never shown as if it were the app

#### Scenario: A failed load retries within a bound
- **WHEN** a load fails
- **THEN** the load is retried with a bounded retry count and delay
- **AND** repeated failures do not spin forever

#### Scenario: A hung load still reveals the window
- **WHEN** neither a successful nor a failed load arrives within a short grace period
- **THEN** the window is revealed regardless
- **AND** the user is never left with no window at all

### Requirement: In-app render self-test
The app MUST be able to verify, on request, that its own window rendered real content and report the result as an exit status.

#### Scenario: Self-test reports a rendered window
- **GIVEN** the self-test is enabled by environment variable
- **WHEN** the window has loaded and mounted its UI
- **THEN** the app reads live DOM state (mounted root, rendered text, document title)
- **AND** captures the renderer's own frame buffer
- **AND** writes a machine-readable report plus a screenshot
- **AND** exits with status 0

#### Scenario: Self-test reports an unrendered window
- **GIVEN** the self-test is enabled
- **WHEN** the window cannot load content (renderer error, unreachable backend)
- **THEN** the report records the failure reason
- **AND** the app exits with a non-zero status

#### Scenario: Self-test is inert unless enabled
- **WHEN** the environment variable is absent
- **THEN** normal runs perform no self-test and do not exit on their own
