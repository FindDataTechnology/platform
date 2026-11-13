## ADDED Requirements

### Requirement: Shared supervisor primitives
The server-descriptor registry, process spawn/stop, HTTP health probing, restart-on-crash with backoff, ordered startup/shutdown, status inspection, and per-server log capture logic SHALL be provided by an Electron-agnostic shared module that takes `projectRoot`, `nodeBin`, `dataDir`, and `agentEnv` as inputs and does not depend on Electron APIs or `process.resourcesPath`. The desktop supervisor SHALL consume this shared module, preserving every existing `desktop-supervisor` scenario with no observable behavior change. The same shared module SHALL be reusable by the headless `local-services-launcher` so both entry points share one lifecycle implementation.

#### Scenario: desktop supervisor delegates to shared primitives
- **WHEN** the Electron app starts the supervisor
- **THEN** the supervisor constructs the shared `Supervisor` with bundle-resolved `nodeBin`, `projectRoot`, `dataDir`, and `agentEnv`
- **AND** ordered startup, health checking, restart-on-crash, ordered shutdown, status, and log capture behave exactly as before

#### Scenario: descriptor resolution is Electron-agnostic
- **WHEN** the shared descriptor resolver runs without `process.resourcesPath` (dev/headless mode)
- **THEN** it resolves bundled resources from `path.join(projectRoot, "resources")`
- **AND** chooses bundled-vs-external per service using the same rules as the packaged supervisor

#### Scenario: shared primitives serve the headless launcher
- **WHEN** the `local-services-launcher` constructs the shared `Supervisor` with dev-resolved parameters
- **THEN** it obtains identical lifecycle behavior (startup ordering, health, restart, shutdown, status, logs) to the desktop supervisor
- **AND** no supervisor lifecycle logic is duplicated
