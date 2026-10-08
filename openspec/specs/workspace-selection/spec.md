# workspace-selection Specification

## Purpose
TBD — created by archiving change composer-control-strip. Update Purpose after archive.

## Requirements

### Requirement: The boot workspace resolves from a deploy pin, then the persisted current workspace

At boot the server SHALL resolve the dsh runtime's initial working directory in this order: the `AGENT_WORKSPACE` environment value when it validates (absolute, existing directory, readable and writable by the server process, symlinks resolved), else the persisted current-workspace preference when it validates, else the process working directory. An `AGENT_WORKSPACE` that fails validation SHALL fall back down the chain with a logged warning naming the rejected value and the fallback — never a silent return to an unwritable root. The env pin SHALL take precedence over the preference so a drifted or stale preference cannot strand the deployment.

#### Scenario: env pin wins

- **WHEN** the server boots with a valid `AGENT_WORKSPACE=/data/workspace` and a persisted preference pointing elsewhere
- **THEN** the runtime starts with `/data/workspace` as its working directory

#### Scenario: persisted current is restored when no pin is set

- **WHEN** the server boots without `AGENT_WORKSPACE` after the user switched to `/home/me/proj` in the previous run
- **THEN** the runtime starts with `/home/me/proj`

#### Scenario: invalid pin falls back loudly

- **WHEN** the server boots with `AGENT_WORKSPACE` pointing at a nonexistent or read-only directory
- **THEN** the runtime starts from the next valid tier in the chain
- **AND** the server logs a warning naming the rejected value and the workspace actually used

### Requirement: Server exposes the active workspace and recent workspaces

The server SHALL respond to a `list_workspaces` WebSocket message with the dsh runtime's current working directory and a list of previously used directories. The recents list SHALL persist across server restarts and SHALL be capped at a fixed maximum, evicting least-recently-used entries. The current workspace SHALL likewise persist across server restarts (subject to the boot-resolution precedence above), so a switch survives a restart unless the deployment pins `AGENT_WORKSPACE`.

#### Scenario: client requests workspaces

- **WHEN** a WebSocket client sends `{ "type": "list_workspaces" }`
- **THEN** the server SHALL reply with `{ "type": "workspaces", "current": "<abs path>", "recents": ["<abs path>", …] }`
- **AND** `current` SHALL be the absolute path the dsh runtime was initialized with

#### Scenario: recents survive a server restart

- **WHEN** the server is restarted after the user has switched workspaces
- **AND** a client sends `{ "type": "list_workspaces" }`
- **THEN** the previously used directories SHALL still be present in `recents`

#### Scenario: current workspace survives a server restart

- **WHEN** the server is restarted after the user switched to `/home/me/proj` and no `AGENT_WORKSPACE` is set
- **THEN** `current` SHALL be `/home/me/proj`

### Requirement: Server validates a requested workspace before switching

The server SHALL validate a requested workspace path before touching the dsh runtime. Validation SHALL require that the path is absolute, that it resolves (following symlinks) to an existing directory, and that the directory is readable AND writable by the server process — a read-only workspace recreates the unwritable-root failure this regime exists to prevent. A path failing any check SHALL be rejected with an `error` and SHALL NOT restart the runtime.

#### Scenario: relative path is rejected

- **WHEN** a client sends `{ "type": "set_workspace", "path": "./src" }`
- **THEN** the server SHALL reply with an `error` naming the reason
- **AND** SHALL NOT restart the dsh runtime

#### Scenario: nonexistent path is rejected

- **WHEN** a client sends a `set_workspace` for a path that does not exist
- **THEN** the server SHALL reply with an `error`
- **AND** the runtime SHALL continue serving prompts from the previous workspace

#### Scenario: path to a file is rejected

- **WHEN** a client sends a `set_workspace` whose path resolves to a regular file
- **THEN** the server SHALL reply with an `error`
- **AND** SHALL NOT restart the dsh runtime

#### Scenario: read-only directory is rejected

- **WHEN** a client sends a `set_workspace` whose path resolves to a directory the server process cannot write to
- **THEN** the server SHALL reply with an `error` naming writability as the reason
- **AND** SHALL NOT restart the dsh runtime

#### Scenario: symlink is resolved before validation

- **WHEN** a client sends a `set_workspace` for a symlink pointing at a directory
- **THEN** the server SHALL validate and store the resolved target path
- **AND** the `workspace_changed` broadcast SHALL carry the resolved path

### Requirement: Server switches the workspace by restarting the dsh runtime

The server SHALL apply a validated workspace change by restarting the dsh child with the new `cwd`, because `cwd` is fixed in the `initialize` handshake and no RPC changes it. On success the server SHALL broadcast `workspace_changed` to all clients, SHALL add the path to the recents list, and SHALL persist the path as the current workspace so the next boot restores it (unless the deployment pins `AGENT_WORKSPACE`). A failed switch that restores the previous workspace SHALL persist the restored path as current.

#### Scenario: valid workspace switch restarts the runtime

- **WHEN** a client sends `{ "type": "set_workspace", "path": "/Users/me/proj" }` and the path validates
- **THEN** the server SHALL restart the dsh runtime with the new `cwd`
- **AND** SHALL broadcast `{ "type": "workspace_changed", "path": "/Users/me/proj" }` to all connected clients
- **AND** the path SHALL appear at the head of the recents list
- **AND** the path SHALL be persisted as the current workspace

#### Scenario: switch is rejected while streaming

- **WHEN** a client sends `set_workspace` while the agent is streaming a response
- **THEN** the server SHALL reply with an `error` stating the agent is busy
- **AND** SHALL NOT restart the runtime

#### Scenario: failed restart is reported

- **WHEN** the dsh runtime fails to start with the new workspace
- **THEN** the server SHALL broadcast an `error` describing the failure
- **AND** SHALL attempt to restore the previous workspace
- **AND** the restored workspace SHALL be persisted as current

### Requirement: Client warns before switching workspace mid-conversation

The client SHALL require explicit confirmation before emitting `set_workspace` when the current session contains messages, because switching the workspace leaves the loaded conversation referencing paths that no longer resolve.

#### Scenario: non-empty session prompts for confirmation

- **WHEN** the user selects a different workspace and the current session has at least one message
- **THEN** the client SHALL present a confirmation naming the consequence
- **AND** SHALL emit `set_workspace` only when the user confirms

#### Scenario: empty session switches without confirmation

- **WHEN** the user selects a different workspace and the current session has no messages
- **THEN** the client SHALL emit `set_workspace` immediately