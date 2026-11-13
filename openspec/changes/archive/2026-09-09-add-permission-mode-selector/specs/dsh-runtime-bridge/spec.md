## ADDED Requirements

### Requirement: The bridge exposes the permission preset roster and live switch
The bridge plugin (the subclassed SDK JSON-RPC server) SHALL serve
`permissions/list` returning every switchable preset with its client label
and description plus the session's effective preset, and `permissions/set`
applying a preset to the live session through the runtime's permission
service. An unknown preset name SHALL fail the RPC call.

#### Scenario: roster lists the composed presets
- **WHEN** the platform requests `permissions/list` after the dsh child is
  ready
- **THEN** the bridge returns the presets from the runtime's permission
  service with display metadata and the current selection

#### Scenario: live switch takes effect without respawning the child
- **WHEN** the platform requests `permissions/set` with a known preset name
- **THEN** the bridge applies the switch to the current session and the same
  dsh child keeps running

### Requirement: Permission state changes flow to the platform as session events
The dsh session events recording permission switches SHALL be translated by
the bridge's event pump into WebSocket broadcasts, so the platform's view of
the current preset stays factual across every origin of change.

#### Scenario: switch event becomes a WebSocket broadcast
- **WHEN** a permission preset switch is recorded on the session
- **THEN** connected web clients receive the updated current preset
