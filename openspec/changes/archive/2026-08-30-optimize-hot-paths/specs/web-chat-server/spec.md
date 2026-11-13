## MODIFIED Requirements

### Requirement: Server serves static frontend files
The server SHALL serve the `web/dist/` directory (SPA, built by Vite) as static files at the root path with a SPA fallback for deep links, with HTTP compression enabled for compressible static assets.

#### Scenario: Browser requests the page
- **WHEN** a browser navigates to `http://localhost:3000`
- **THEN** the server SHALL return the React SPA entry `web/dist/index.html`

#### Scenario: compressible asset is requested
- **WHEN** a client requests a large text-based asset (e.g. the app entry chunk) with `Accept-Encoding` allowing gzip/br
- **THEN** the server SHALL return the asset content-compressed rather than uncompressed

## ADDED Requirements

### Requirement: Server listens before background initialization completes
The server SHALL accept TCP connections and serve static files and non-agent endpoints within ~1 second of process start, before dsh agent startup, legacy migrations, catalog loading, and cron initialization complete. Initialization groups with no ordering dependency SHALL run concurrently. Endpoints and WebSocket commands that require the dsh agent SHALL respond with an explicit initializing error (HTTP 503 / WS error event) until the agent is ready, and clients SHALL be notified when it becomes ready.

#### Scenario: static assets answer during cold start
- **WHEN** the server process has just started and the dsh agent is still handshaking
- **THEN** an HTTP request for the SPA entry SHALL succeed without waiting for agent readiness

#### Scenario: chat command during initialization
- **WHEN** a client sends a `prompt` WebSocket command before the dsh agent is ready
- **THEN** the server SHALL respond with an initializing error instead of crashing or hanging
- **AND** the server SHALL emit a readiness event to connected clients once the agent is available

#### Scenario: catalog cloud fetch does not block readiness
- **WHEN** the remote agents catalog URL is slow or unreachable (up to its 10s timeout)
- **THEN** the server SHALL already be listening and serving the local catalog
- **AND** cloud catalog entries SHALL merge in when the fetch completes
