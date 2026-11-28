# local-services-launcher Specification

## Purpose
Defines the headless (non-Electron) launcher invoked by `npm start`, which brings up `server.js` under the shared supervisor primitives: no application window, health checking, restart-on-crash, ordered shutdown, log capture, and idempotent seeding of dev state under the data directory.

## Requirements

### Requirement: Headless launcher entry point
The system SHALL provide a headless (non-Electron) process supervisor invoked by `npm start` that orchestrates `server.js` as a child process using the same shared primitives as the desktop supervisor. The launcher SHALL open no application window and SHALL stay alive to supervise its children until interrupted. Behavior SHALL be observably equivalent to running `node server.js` directly, plus supervision.

#### Scenario: npm start brings up server.js
- **WHEN** a developer runs `npm start`
- **THEN** the launcher spawns `server.js` as a supervised child process
- **AND** opens no window
- **AND** stays alive to supervise it until interrupted

#### Scenario: bind address is configurable
- **WHEN** `PORT` or `HOST` is set in the environment
- **THEN** the launcher SHALL pass them through to `server.js`
- **AND** the app SHALL be served on that address rather than the default `localhost:3000`

#### Scenario: launcher shuts down cleanly on interrupt
- **WHEN** the launcher receives SIGINT or SIGTERM
- **THEN** it runs ordered shutdown of all spawned children in reverse startup order
- **AND** does not trigger restart-on-crash logic for the shutdown

### Requirement: Dev first-run seeding of settings
The launcher SHALL perform an idempotent first-run seeding step before starting the supervisor: it SHALL create the dev settings file under `PLATFORM_DATA_DIR` when absent, and SHALL merge in any missing defaults when it already exists, writing atomically (temp file + rename). Existing values MUST NOT be overwritten. The seeding logic SHALL be the same Electron-agnostic implementation the packaged first-run bootstrap uses.

#### Scenario: fresh dev run seeds the settings file
- **WHEN** the launcher starts with no dev settings file in the data dir
- **THEN** it writes the dev settings file atomically with the default values
- **AND** injects them into the spawned child's environment

#### Scenario: second dev run preserves existing settings
- **WHEN** the launcher starts and the dev settings file already exists
- **THEN** it does NOT overwrite existing values
- **AND** completes seeding without error

#### Scenario: dev credentials never reach the browser
- **WHEN** the browser or any renderer requests configuration via WS or HTTP
- **THEN** the response MUST NOT include any credential held in the dev settings file

### Requirement: Lifecycle parity with the desktop supervisor
The launcher SHALL provide ordered startup with dependency readiness, HTTP health checking per transport, automatic restart on unexpected failure with backoff, ordered shutdown, status inspection, and per-server log capture for every spawned server - using the shared supervisor primitives, with behavior identical to the desktop supervisor.

#### Scenario: crashed child self-heals
- **WHEN** a spawned process exits unexpectedly
- **THEN** the launcher restarts it after a backoff delay
- **AND** the remaining supervised servers are unaffected

#### Scenario: unhealthy server is reported with a clear error
- **WHEN** a spawned server fails its health check within the startup timeout
- **THEN** the launcher marks that server unhealthy with a clear error
- **AND** surfaces its captured log tail

#### Scenario: status and logs are inspectable
- **WHEN** the status of the launcher's children is requested
- **THEN** each server's state, pid, assigned port, and recent log lines SHALL be returned

### Requirement: Dev state location and gitignore
The launcher SHALL place all dev-generated state under `PLATFORM_DATA_DIR` (CWD-relative when unset, matching `paths.js`). The dev settings file (which may contain generated credentials) SHALL be covered by `.gitignore` so generated secrets are not committed.

#### Scenario: dev state lives under the data dir
- **WHEN** the launcher seeds config and spawns servers with `PLATFORM_DATA_DIR` unset
- **THEN** the dev settings file is written under the CWD-relative data dir
- **AND** not under the project source tree

#### Scenario: dev settings file is gitignored
- **WHEN** checking git ignore status of the dev settings file
- **THEN** it SHALL be matched by an entry in `.gitignore`
