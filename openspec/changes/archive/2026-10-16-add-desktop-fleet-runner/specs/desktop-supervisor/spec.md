# desktop-supervisor — Spec Delta

## MODIFIED Requirements

### Requirement: Server descriptor registry
The supervisor SHALL manage a registry of server descriptors. Each descriptor SHALL declare the server's id, runtime kind (`node` / `http-external`), start command, working directory, environment, transport (`http-port` or `stdio-rpc`), health-check probe, dependency list, and whether the server is optional. A descriptor's `enabled` flag SHALL be resolved from the injected environment at supervisor construction, so an optional plugin service (openspec: desktop-fleet-runner) ships preinstalled yet stays unstarted until its switch is persisted and the app restarts.

#### Scenario: App launches with the default servers
- **WHEN** the Electron app starts
- **THEN** the supervisor loads the `server-js` descriptor
- **AND** begins orchestrating it according to its declared dependencies

#### Scenario: A disabled plugin descriptor is skipped

- **WHEN** the app starts without the Wanxing plugin switch enabled in settings
- **THEN** the supervisor marks the `agent-runner-js` descriptor disabled and never spawns it

#### Scenario: An enabled plugin descriptor starts with its own health probe

- **WHEN** the app starts with the Wanxing plugin switch enabled
- **THEN** the supervisor starts `agent-runner-js` and polls its own health endpoint independently of `server-js`
