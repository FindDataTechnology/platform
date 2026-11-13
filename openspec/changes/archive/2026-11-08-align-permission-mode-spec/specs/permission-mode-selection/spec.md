# permission-mode-selection 校正

## MODIFIED Requirements

### Requirement: The control strip shows the session's effective permission preset

The chat composer control strip SHALL render a permission control showing the
effective preset of the current session as its LOCALIZED label (the roster's
`label` rendered in the UI locale; an entry the roster does not list falls back
to the server's raw label), populated only from server state (no optimistic
local value). The control SHALL be hidden while the roster has not been
received, and SHALL be disabled while the client is not connected or a turn is
streaming (one gate in the UI, not two different rules).

#### Scenario: strip renders server state on connect

- **WHEN** a client connects and the server broadcasts the permission roster
- **THEN** the control strip shows the effective preset reported by the server, rendered as its localized label

#### Scenario: unknown preset resolves to custom

- **WHEN** the effective sandbox/approval values match no preset in the table
- **THEN** the control shows the `custom` placeholder instead of a preset name

#### Scenario: custom is displayed but never offered

- **WHEN** the effective preset is `custom`
- **THEN** the control displays it, and `custom` does not appear among the switchable entries (the roster carries only the presets the runtime composes)

### Requirement: A dsh restart resets the permission to the deployment default

Because permission state is durable per dsh session, a genuine child restart —
an agent-preset or workspace switch, or a crash/backoff respawn — SHALL start
the next session at the deployment default (`DSH_PERMISSION_MODE`), and the
control SHALL render that reset value from server state once the new session
reports it. A model switch is NOT such a restart: `model/set` is a live method,
the child keeps running, and the mode the user chose SHALL carry across it —
switching models MUST NOT silently revoke an explicitly chosen permission mode.

#### Scenario: restart lands back on the default

- **WHEN** the user switched to `danger-full-access` and then switches the agent preset or the workspace (which restarts the dsh child)
- **THEN** the next session runs under the deployment default and the control shows it after the restart completes

#### Scenario: a model switch carries the chosen mode across

- **WHEN** the user has chosen a non-default preset and then switches the model
- **THEN** the session keeps running with the chosen preset, and the control still shows it once the switch settles

### Requirement: WebSocket permission contract

The server and client SHALL exchange permission state over the existing
WebSocket using these messages only:

| Direction | Message | Payload |
|---|---|---|
| server→client | `permissions` | `{ options: [{name,label,description}], current }` on connect and in reply to `list_permissions` (a switch pushes only `current_permission`) |
| server→client | `current_permission` | `{ name }` |
| client→server | `list_permissions` | — |
| client→server | `set_permission` | `{ name }` — streaming guard; unknown name → `error` to sender only |

#### Scenario: roster request returns options with display metadata

- **WHEN** a client sends `list_permissions`
- **THEN** the server replies with every switchable preset including label
  and description plus the current selection
- **AND** a client that does not ask keeps the roster it got on connect: a switch answers with `current_permission` alone
