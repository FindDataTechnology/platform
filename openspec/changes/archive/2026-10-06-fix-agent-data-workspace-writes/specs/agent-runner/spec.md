## ADDED Requirements

### Requirement: Declared data workspaces are writable under the session sandbox

A deployed role whose descriptor declares an enabled data workspace SHALL run its sessions with a sandbox writable root that covers that data directory: file writes into it succeed under the default `workspace-write` posture without escalation, and the sandbox posture everywhere else is unchanged. Roles without a data-workspace declaration SHALL keep sandbox behavior identical to deployments predating the feature.

#### Scenario: Write inside the data workspace succeeds

- **WHEN** a session on a workspace-declared deployed role writes a file under its data directory
- **THEN** the write succeeds without approval or escalation, and a subsequent read of the same path returns the written content

#### Scenario: Writes outside the writable root remain denied

- **WHEN** the same session attempts a write outside its writable root (for example into the application tree)
- **THEN** the write is refused fail-closed exactly as before this change

#### Scenario: No declaration changes nothing

- **WHEN** a deployed role without a data-workspace declaration runs a turn
- **THEN** its sandbox writable root and launch parameters are indistinguishable from a deployment predating data workspaces

#### Scenario: Quota guardrail posture is unchanged

- **WHEN** a declared data workspace grows past its declared quota
- **THEN** the runner reports the breach (meter line + fleet event) and still neither deletes workspace data nor blocks turns
