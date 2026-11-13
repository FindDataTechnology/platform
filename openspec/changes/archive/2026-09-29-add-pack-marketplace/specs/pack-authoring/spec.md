## Purpose

How creators compose a pack inside their own cell — drafts, the manifest content model, and the publish action that freezes a version into the marketplace.

## ADDED Requirements

### Requirement: Pack drafts persist in the author's cell

A creator SHALL be able to create, edit, and delete pack drafts in their own cell. A draft SHALL contain a display name, description, tags, a list of skill entries, a list of MCP references, and a list of agent persona entries. Drafts SHALL persist in the author's cell storage across restarts and SHALL remain private to the author's cell until published.

#### Scenario: Draft survives a restart

- **WHEN** the author saves a draft, the cell restarts, and the author reopens the pack editor
- **THEN** the draft is listed with all its entries exactly as saved

#### Scenario: Drafts stay private

- **WHEN** a draft exists in the author's cell and it has never been published
- **THEN** no other user can see any trace of it in the marketplace

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

Each draft agent entry SHALL carry a display name, persona text, and optional tags and icon. The v1 editor SHALL NOT accept endpoint, model, or credential fields for agent entries — pack agents run as local personas on the platform's currently selected model.

#### Scenario: Persona-only agent entry

- **WHEN** the author adds an agent entry with a display name and persona text and saves the draft
- **THEN** the entry persists with exactly those fields and no endpoint or model field exists in the editor

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
