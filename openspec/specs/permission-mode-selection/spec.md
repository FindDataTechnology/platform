# permission-mode-selection Specification

## Purpose

Lets the user see and switch, per chat session, which permission preset the
dsh runtime enforces — the sandbox/approval bundle (`read-only`,
`workspace-write`, `danger-full-access`) — from the composer control strip.

## Requirements

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

### Requirement: Selecting a preset switches the live session without a restart
The server SHALL apply a permission preset switch to the current dsh session
in place (no child restart, composer send stays enabled once the confirming
broadcast lands). The switch SHALL be rejected while a turn is streaming, and
an unknown preset name SHALL produce an error delivered only to the
requesting client.

The client SHALL require an explicit risk acknowledgement before requesting
the `danger-full-access` preset: selecting it SHALL open a localized
confirmation dialog naming the preset and its risk, with an acknowledgement
control that enables the confirm action; `set_permission` SHALL be sent only
from that confirmed action, and that message SHALL carry
`acknowledge: true`. Cancelling, dismissing, or Escape SHALL send nothing and
leave the effective preset unchanged. All other presets SHALL apply
immediately on selection as before. The client SHALL display
`danger-full-access` as `Full access` in the control and roster.

The server SHALL enforce the same precondition rather than trusting the
client's dialog: a `set_permission` request naming `danger-full-access`
without `acknowledge: true` SHALL be refused with an error delivered only to
the requesting client, leaving the effective preset unchanged and the bridge
untouched. Roster validation SHALL run before this check, so an unknown preset
name is still reported as unknown and a deployment composing no full-access
preset still reports that. A request naming the preset already in effect SHALL
remain a successful no-op without the flag — it escalates nothing.

#### Scenario: user tightens the mode mid-session
- **WHEN** the user selects `read-only` while no turn is streaming
- **THEN** the switch applies to the live session and every connected client
  receives the new current preset

#### Scenario: switch during streaming is rejected
- **WHEN** the user selects a preset while a turn is streaming
- **THEN** the server rejects the request with an error to the requesting
  client and the effective preset is unchanged

#### Scenario: full access requires acknowledgement
- **WHEN** the user selects `danger-full-access` while no turn is streaming
- **THEN** the client SHALL open the confirmation dialog and SHALL NOT send
  `set_permission` yet
- **AND** the confirm action SHALL be disabled until the acknowledgement is
  checked
- **WHEN** the user then confirms
- **THEN** the client SHALL send `set_permission` for `danger-full-access` with
  `acknowledge: true`

#### Scenario: the server refuses full access without the acknowledgement
- **WHEN** a client sends `set_permission` naming `danger-full-access` without
  `acknowledge: true` (a raw protocol client, or any sender that skipped the
  dialog)
- **THEN** the server SHALL refuse the switch with an error to that client only
- **AND** the effective preset SHALL be unchanged and no permission call SHALL
  reach the bridge

#### Scenario: the acknowledgement unlocks the switch
- **WHEN** a client sends `set_permission` naming `danger-full-access` with
  `acknowledge: true` while no turn is streaming
- **THEN** the switch applies to the live session exactly as a roster-valid
  switch does

#### Scenario: an unknown name is still reported as unknown
- **WHEN** a client sends `set_permission` naming a preset outside the roster,
  with or without `acknowledge`
- **THEN** the server reports the unknown preset name, not an acknowledgement
  error

#### Scenario: dismissing the confirmation changes nothing
- **WHEN** the confirmation dialog is open and the user cancels, presses
  Escape, or clicks outside
- **THEN** no `set_permission` SHALL be sent and the control SHALL continue
  showing the previously effective preset

### Requirement: Every client reflects the session's permission state
The server SHALL broadcast the permission roster on client connect and the
current preset after every successful switch, so multiple open clients stay
consistent.

#### Scenario: second client observes a switch made elsewhere
- **WHEN** client A switches the preset and client B is connected
- **THEN** client B's control updates to the new preset without a reload

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
| client→server | `set_permission` | `{ name, acknowledge? }` — streaming guard; `danger-full-access` without `acknowledge: true` → `error` to sender only; unknown name → `error` to sender only |

#### Scenario: roster request returns options with display metadata

- **WHEN** a client sends `list_permissions`
- **THEN** the server replies with every switchable preset including label
  and description plus the current selection
- **AND** a client that does not ask keeps the roster it got on connect: a switch answers with `current_permission` alone

#### Scenario: the payload carries the acknowledgement verbatim

- **WHEN** a client sends `set_permission` with `{ name, acknowledge: true }`
- **THEN** the server reads the flag from that message and applies the switch,
  never inferring it from any other channel
