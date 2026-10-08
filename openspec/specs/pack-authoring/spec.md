# pack-authoring Specification

## Purpose
How creators compose a pack inside their own cell — drafts, the manifest content model, and the publish action that freezes a version into the marketplace.

## Requirements

### Requirement: Pack drafts persist in the author's cell

A creator SHALL be able to create, edit, and delete pack drafts in their own cell. A draft SHALL contain a display name, description, tags, a list of skill entries, a list of MCP references, and a list of agent persona entries. Drafts SHALL persist in the author's cell storage across restarts and SHALL remain private to the author's cell until published.

#### Scenario: Draft survives a restart

- **WHEN** the author saves a draft, the cell restarts, and the author reopens the pack editor
- **THEN** the draft is listed with all its entries exactly as saved

#### Scenario: Drafts stay private

- **WHEN** a draft exists in the author's cell and it has never been published
- **THEN** no other user can see any trace of it in the marketplace

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

### Requirement: Skills are composed inline

Each draft skill entry SHALL carry a name, a description, and the full skill body, edited with the same conventions as the platform's custom skills. The editor SHALL validate skill-name format and per-entry size limits before a publish can be submitted.

#### Scenario: Author writes a skill body

- **WHEN** the author adds a skill entry with name, description, and body and saves the draft
- **THEN** the entry persists and is listed in the editor with its body editable

#### Scenario: Malformed skill name is caught before publish

- **WHEN** the author enters a skill name with characters outside the allowed format and attempts to publish
- **THEN** the editor blocks the publish and names the offending entry

### Requirement: MCP entries are picked from the market catalog

The author SHALL select MCP entries from the registry-sourced entries of the cell's market catalog; the draft SHALL store a registry-name reference (with the entry's display metadata for preview). The v1 editor SHALL NOT offer a free-form endpoint or command entry for MCP entries.

#### Scenario: Picker lists registry servers

- **WHEN** the author opens the MCP picker
- **THEN** the registry-sourced market entries visible to the author are listed and selectable

#### Scenario: No free-form MCP entry

- **WHEN** the author composes the MCP list of a draft
- **THEN** no field accepts a URL or command configuration


### Requirement: Agents are persona entries

Each draft agent entry SHALL carry a display name, persona text, and optional tags and icon. An agent entry MAY carry a resource declaration naming, per role, a subset of the draft's own skill entries and MCP references; each dimension (skills, MCP) is optional, and an absent dimension means the role uses the whole pack's set for that dimension. The editor SHALL offer per-role resource pickers listing only the draft's own skill entries and MCP references, and SHALL surface a persona cost readout (approximate tokens per turn) alongside the persona text while editing. The editor SHALL NOT accept endpoint, model, or credential fields for agent entries — pack agents run as local personas on the platform's currently selected model.

An agent entry MAY additionally carry a serving contract (`serving`): a declaration that the role is deployable as an Agent Service over the A2A protocol (openspec: a2a-agent-serving). The contract SHALL contain a protocol identifier and an optional manual card declaration; absent card fields SHALL be derived at deploy time from the role's name/description/tags. The contract MAY additionally carry a work rhythm (`serving.rhythm`): a declarative list of schedules (and, in later versions, event sources) the deployed agent works by — a rhythm is the autonomy grant, and a contract without one deploys an agent that only answers (openspec: agent-residency). Rhythm entries SHALL be schedule declarations only; validation SHALL reject rhythm fields that name models, endpoints, or credentials. The contract MAY additionally carry a turn budget (`serving.budget.turnMinutes`): a whole-number ceiling in minutes on any single turn of the deployed agent — the budget is a duration declaration, and validation SHALL reject budget shapes that are not a positive whole number within the platform cap. The contract's card capability declarations live under the contract's own namespace and are distinct from the pack's skill files — same word, different meaning — and validation SHALL reject contract fields that name endpoints, models, or credentials. When no contract is present, every pre-existing rule of this requirement applies verbatim.

#### Scenario: Persona-only agent entry

- **WHEN** the author adds an agent entry with a display name and persona text and saves the draft
- **THEN** the entry persists with exactly those fields and no endpoint or model field exists in the editor

#### Scenario: Per-role picker offers only the draft's own entries

- **WHEN** the author opens a role's resource picker
- **THEN** it lists exactly the draft's skill entries and MCP references, and no free-form skill or server entry exists

#### Scenario: Declaration referencing a foreign name is caught before publish

- **WHEN** a role's declaration names a skill or MCP reference that is not in the draft's own lists and the author attempts to publish
- **THEN** the editor blocks the publish naming the offending role and entry

#### Scenario: Persona cost is visible while editing

- **WHEN** the author edits a role's persona text
- **THEN** the editor shows the current length and an approximate per-turn token cost for it

#### Scenario: Contract-free entries are unchanged

- **WHEN** a draft agent entry carries no serving contract
- **THEN** the entry validates and behaves exactly as before this change

#### Scenario: Minimal contract validates

- **WHEN** the author adds a serving contract consisting of only the protocol identifier and saves
- **THEN** the draft validates and publish succeeds, with card display fields to be derived at deploy time

#### Scenario: Contract cannot smuggle runtime configuration

- **WHEN** a serving contract contains a model, endpoint, or credential field
- **THEN** validation rejects the draft naming the forbidden field

#### Scenario: Card capabilities are namespace-isolated from skill files

- **WHEN** a serving contract declares card capabilities and the pack also ships skill files
- **THEN** the two coexist without collision — the capability declarations never reference or consume the skill files' contents

#### Scenario: Rhythm declares cadence declaratively

- **WHEN** the author adds a serving contract carrying a rhythm of schedule entries and saves
- **THEN** the draft validates and the rhythm travels with the contract as the role's declared work cadence; a contract without a rhythm declares an answering-only agent

#### Scenario: Rhythm cannot smuggle runtime configuration

- **WHEN** a rhythm entry carries a model, endpoint, or credential field
- **THEN** validation rejects the draft naming the forbidden field

#### Scenario: Budget declares a turn ceiling declaratively

- **WHEN** the author adds a serving contract carrying `budget.turnMinutes` of a positive whole number within the platform cap and saves
- **THEN** the draft validates and the budget travels with the contract as the role's declared turn ceiling; a contract without a budget declares no ceiling of its own and the deployment default applies

#### Scenario: Budget rejects non-duration shapes

- **WHEN** `budget.turnMinutes` is not a whole number, is not positive, or exceeds the platform cap
- **THEN** validation rejects the draft naming the offending value

### Requirement: Publish action freezes the next version

Publishing a draft SHALL submit it to the gateway publish endpoint with the author's identity. A successful first publish SHALL return a new pack identifier and version 1; subsequent publishes of the same draft SHALL return the next version number. The draft SHALL remain editable after publishing so the author can prepare the next version. Publish rejections (validation, gate, throttling) SHALL surface in the editor with the returned reason.

#### Scenario: First publish

- **WHEN** the author publishes a draft that passes validation and the creator gate
- **THEN** the response returns a new pack identifier and version 1, and the draft remains in the editor

#### Scenario: Next version

- **WHEN** the author edits a published draft and publishes again
- **THEN** the response returns the same pack identifier with version 2

#### Scenario: Gate rejection surfaces in the editor

- **WHEN** a user without the creator group attempts to publish from the editor
- **THEN** the editor shows the authorization rejection and nothing is published

### Requirement: Pack identifiers are server-assigned

The author SHALL NOT choose the pack identifier. Publishing a draft to a different pack (forking) SHALL be supported by the author explicitly starting a new draft, never by editing an identifier.

#### Scenario: Author cannot set the identifier

- **WHEN** the author composes and publishes a draft
- **THEN** the identifier is assigned by the gateway and is not an editable field anywhere in the editor
