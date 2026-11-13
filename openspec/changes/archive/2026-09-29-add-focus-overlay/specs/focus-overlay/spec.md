## Purpose

Subscriber-side adjustment of a focused role's effective resource set: per-role add/remove preferences that compose over the derived set at every composition point — never a stored snapshot. Applies to focused roles — pack personas now, custom presets when add-custom-presets lands; full-mode presets keep the existing availability semantics.

## ADDED Requirements

### Requirement: Overlay is a preference diff, not a stored set

The platform SHALL store a user's adjustments for a focused role as per-role add/remove preferences (MCP server names and skill names), separate from any derived set. The effective set SHALL be recomposed from the selected preset's derivation together with these preferences at every composition point (boot, preset switch, MCP or skill configuration change, crash respawn); no materialized resource set SHALL be stored as independent state. An adjustment SHALL follow the serialized runtime-mutation path and apply to the next session; an adjustment requested while a turn is streaming SHALL be rejected, matching the preset-switch guard.

#### Scenario: Adjustment survives a restart

- **WHEN** a role's overlay adds a server and removes a skill, the deployment restarts, and the role is selected again
- **THEN** the recomposed focused set reflects both adjustments — recomposed from the preset's derivation plus the preferences, with no stored set involved

#### Scenario: Adjustment rejected mid-stream

- **WHEN** an overlay adjustment is requested while a turn is streaming
- **THEN** the adjustment is rejected with an error, matching the existing `set_model` / `set_preset` guard

#### Scenario: Adjustment applies to the next session

- **WHEN** an overlay adjustment is accepted while sessions exist
- **THEN** running sessions keep their composed runtime and the next session composes with the adjusted set

### Requirement: Additions draw only from the enabled universe

An overlay addition SHALL be limited to resources the composing identity could already use: MCP servers that are installed, visible to the identity's groups, and enabled for it, and skills available in the cell. An addition SHALL NOT re-enable a server that the user or the identity's role gating has disabled; an added skill SHALL compose only while a skill by that name is available in the cell.

#### Scenario: Disabled server stays omitted despite addition

- **WHEN** the overlay adds a server the user has disabled
- **THEN** the focused runtime still omits that server

#### Scenario: Enabled non-pack server appears in the focused set

- **WHEN** the overlay adds an installed, visible, enabled server that the pack does not reference
- **THEN** the focused runtime exposes that server alongside the role's derived set and the baseline

#### Scenario: Added skill from another pack composes into the role

- **WHEN** the overlay adds a skill owned by another installed pack
- **THEN** the focused role exposes that skill, and stops exposing it when its pack is uninstalled

### Requirement: Removals are always legal

An overlay removal SHALL be allowed against any member of the role's effective set, including baseline servers and pack-owned skills. Removals are user-level narrowing: they SHALL NOT alter the baseline definition, the pack manifest, other roles' sets, or full mode.

#### Scenario: Baseline server removed for this role only

- **WHEN** the overlay removes a baseline server for a role
- **THEN** that role's focused runtime starts without the server, while other roles and full mode still load it

#### Scenario: Removed skill stays in full mode

- **WHEN** the overlay removes a pack-owned skill from a role
- **THEN** the role's focused set excludes it while full mode still lists it

### Requirement: Overlay entries self-heal on drift

When the derivation inputs change — a pack upgrade adding, dropping, or renaming resources; a server uninstalled; a skill removed — overlay entries that no longer resolve SHALL be ignored silently in composition, and entries that regain meaning SHALL apply again. The overlay SHALL NOT block pack upgrades and SHALL NOT produce error states requiring repair.

#### Scenario: Upgrade drops an added server

- **WHEN** a pack upgrade or server uninstall makes an added server name unresolvable
- **THEN** composition ignores the entry silently and the focused set recomposes without it

#### Scenario: A removal regains no effect after rename

- **WHEN** a pack upgrade renames a skill that a role's overlay had removed
- **THEN** the renamed skill composes as part of the derived set (the stale removal entry targets a name that no longer exists)

### Requirement: Adjustment panel in the web picker

The web agent picker SHALL offer, for each focused role, an adjustment view listing the role's effective set with per-item removal affordances and addable servers and skills drawn from the enabled universe; applying changes writes the preference diff and follows the next-session contract. Miniprogram parity is out of scope for this change.

#### Scenario: Panel round-trips an adjustment

- **WHEN** the user adds one server and removes one skill in the panel and applies
- **THEN** the preferences are stored, the next session composes accordingly, and reopening the panel shows the adjusted effective set
