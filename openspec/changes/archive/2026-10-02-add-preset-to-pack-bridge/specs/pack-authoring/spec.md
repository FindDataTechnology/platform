# pack-authoring Delta

## ADDED Requirements

### Requirement: Drafts can be pre-filled from a custom preset

The platform SHALL provide a server-side conversion that creates a new pack draft from one of the author's custom presets, resolving reference migratability itself. The conversion SHALL carry the preset's display name, persona text, tags, and icon verbatim into the draft and its single agent entry, and SHALL pre-set that agent entry's serving contract to the A2A protocol declaration (the author MAY remove it). Skill references that resolve to the author's own skills or the deployment baseline SHALL be inlined as draft skill entries with their full bodies; references to other packs' skills SHALL NOT be carried. MCP references that resolve to a market-catalog entry SHALL be stored as that entry's registry-name reference; unmatched references SHALL NOT be carried. The conversion response SHALL carry a report listing what was inlined and what was left for the author to replace, and the editor SHALL surface that report. A converted draft is an ordinary draft: it validates, publishes, and diverges from its source preset freely, with no synchronization in either direction.

#### Scenario: All-migratable preset converts clean

- **WHEN** the author converts a preset whose skills are all their own or baseline and whose servers all match market-catalog entries
- **THEN** the created draft inlines every skill with its body, stores every server as a registry-name reference, carries the persona verbatim, pre-sets the A2A serving contract, and the report lists everything as inlined with nothing pending

#### Scenario: Foreign skill is flagged, not carried

- **WHEN** the converted preset references a skill owned by an installed pack
- **THEN** the draft omits that skill and the report lists it as pending replacement, naming the owning pack

#### Scenario: Unmatched server is flagged, not carried

- **WHEN** the converted preset references a server with no counterpart in the market catalog
- **THEN** the draft omits that server and the report lists it as pending replacement

#### Scenario: Converted draft is ordinary

- **WHEN** the author edits the converted draft and publishes it
- **THEN** it goes through the same validation and publish gate as any draft, and subsequent edits to the source preset never reach the published pack

#### Scenario: Serving contract is pre-set but removable

- **WHEN** the conversion creates the agent entry
- **THEN** the entry carries the A2A serving declaration, and the author can remove it in the editor exactly like a hand-authored entry
