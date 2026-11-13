## MODIFIED Requirements

### Requirement: Server descriptor registry
The supervisor SHALL manage a registry of server descriptors. Each descriptor SHALL declare the server's id, runtime kind (`node` / `python` / `http-external`), start command, working directory, environment, transport (`http-port` or `stdio-rpc`), health-check probe, dependency list, and whether the server is optional. Descriptors for `openconnector` and `litellm` SHALL resolve at supervisor construction time to their **bundled** form (`kind: "node"` or `kind: "python"`, `start` populated) when their bundled resources are present on disk AND the user has not set an explicit external base URL for that service; otherwise they SHALL resolve to their **external** form (`kind: "http-external"`, `start: null`), preserving the existing behavior.

#### Scenario: App launches with the four default servers
- **WHEN** the Electron app starts
- **THEN** the supervisor loads descriptors for `server.js`, `pi-agent`, `litellm`, and `openconnector`
- **AND** begins orchestrating them according to their declared dependencies

#### Scenario: Bundled OpenConnector resources are present
- **WHEN** `resources/openconnector/dist/index.js` exists in the app bundle
- **AND** `settings.json` does not set `OPENCONNECTOR_BASE_URL` to an external URL
- **THEN** the `openconnector` descriptor resolves to `kind: "node"` with `start.cmd = <bundled node>` and `start.args = [<oc dist entry>]`
- **AND** the supervisor spawns the OpenConnector process on a free localhost port

#### Scenario: Bundled LiteLLM resources are present
- **WHEN** `resources/litellm/venv/bin/litellm` exists in the app bundle
- **AND** `resources/python/bin/python3` exists in the app bundle
- **AND** `settings.json` does not set `LITELLM_BASE_URL` to an external URL
- **THEN** the `litellm` descriptor resolves to `kind: "python"` with `start.cmd = <venv litellm>` and `start.args = ["--port", <freePort>, "--config", "<userData>/litellm.yaml"]`
- **AND** the supervisor spawns the LiteLLM process on a free localhost port

#### Scenario: External override wins over bundled resources
- **WHEN** bundled OpenConnector resources are present in the bundle
- **AND** the user has set `OPENCONNECTOR_BASE_URL=https://oc.example.com` in `settings.json`
- **THEN** the `openconnector` descriptor resolves to `kind: "http-external"` with that URL
- **AND** the supervisor health-checks the external service and does NOT spawn the bundled process

### Requirement: Ordered startup with dependency readiness
The supervisor SHALL start servers in dependency order and SHALL wait for each server's health check to pass before starting servers that depend on it. When bundled `litellm` and `openconnector` are spawned, they SHALL start in parallel with (not before) `server.js` — `server.js` SHALL treat them as optional and MUST NOT block on their readiness.

#### Scenario: pi-agent starts before server.js
- **WHEN** the app starts
- **THEN** the supervisor starts `pi-agent` and waits for its RPC health check to pass
- **BEFORE** starting `server.js`, which declares `pi-agent` as a dependency

#### Scenario: external servers are health-checked, not spawned
- **WHEN** `litellm` and `openconnector` are configured as `http-external` (URLs only)
- **THEN** the supervisor polls their health endpoints
- **AND** does NOT spawn a process for them
- **AND** marks them green or red without blocking app launch when they are optional

#### Scenario: bundled optional services do not block the window
- **WHEN** bundled `litellm` and `openconnector` are declared as spawned
- **AND** `server.js` becomes healthy before them
- **THEN** the Electron main process opens the window pointed at `server.js` immediately
- **AND** the bundled services continue starting in the background

## ADDED Requirements

### Requirement: Python runtime kind support
The supervisor SHALL support `kind: "python"` server descriptors, spawning them via the same `spawnServer` primitive used for `kind: "node"`. The descriptor's `start.cmd` SHALL point at an interpreter (typically a venv `bin/litellm` or `bin/python3`) that exists on disk when the descriptor is enabled.

#### Scenario: python descriptor spawn
- **WHEN** a `python` descriptor is enabled and its `start.cmd` path exists
- **THEN** the supervisor spawns the child with the given cmd/args/env
- **AND** captures its stdout/stderr into the log ring buffer
- **AND** health-checks it via HTTP on its assigned port

#### Scenario: python descriptor missing interpreter
- **WHEN** a `python` descriptor is enabled but `start.cmd` does not exist on disk
- **THEN** the supervisor marks the server `unhealthy` with a clear error
- **AND** does NOT crash the supervisor or block other servers

### Requirement: Free-port assignment for bundled optional servers
The supervisor SHALL assign a free localhost port to each bundled spawned server (`openconnector`, `litellm`) at launch, distinct from `server.js`'s port. The resolved URLs SHALL be injected into `server.js`'s environment as `OPENCONNECTOR_BASE_URL` and `LITELLM_BASE_URL` so `server.js` and its modules discover the bundled services identically to external ones.

#### Scenario: server.js receives bundled sibling URLs
- **WHEN** bundled OC and LiteLLM are spawned on ports X and Y
- **THEN** `server.js` starts with `OPENCONNECTOR_BASE_URL=http://127.0.0.1:X` and `LITELLM_BASE_URL=http://127.0.0.1:Y` in its environment
- **AND** its OpenConnector and LiteLLM integrations use those URLs with no code change
