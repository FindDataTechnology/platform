## Purpose

A single visual composition surface where an agent's three buckets (persona, skills, MCP tools) are edited as one card, a team's structure is seen as one graph, validation and provenance are visible while composing, and the same document is emitted into existing lifecycles without a second content model or validator.

## ADDED Requirements

### Requirement: Studio is a single three-pane composition surface

The system SHALL provide one composition surface for building an Agent Document, laid out in three panes: a **roster** (the agents and teams in the working document), a **canvas** (the selected agent as a three-bucket card, or the team as a node graph), and a **preview/inspect** pane (structural preview, live validation, provenance, and locale-overlay status). The surface SHALL compose the existing Agent Document shape and SHALL NOT introduce a second content model.

#### Scenario: Compose a single agent
- **WHEN** the user creates a new agent in the studio
- **THEN** the canvas shows its persona, skills, and MCP buckets as one card, and the roster lists it as the working document's first agent

#### Scenario: Compose a team
- **WHEN** the working document contains multiple agents plus a team organization block
- **THEN** the canvas shows the team as a node graph whose members are the document's agents

### Requirement: The three buckets are individually editable on the card

Each of the agent's three buckets SHALL be editable from the canvas card: the persona text; the skills (selected from locally-available skills or authored inline); and the MCP references (selected from the registered catalog, optionally narrowed by a tool allowlist). Editing a bucket SHALL update the working document immediately and SHALL NOT require leaving the surface.

#### Scenario: Edit the persona bucket
- **WHEN** the user edits the persona text on the card
- **THEN** the working document's agent persona updates in place

#### Scenario: Edit the skills and MCP buckets
- **WHEN** the user adds a skill and selects an MCP reference with a narrowed tool allowlist
- **THEN** both buckets reflect the change on the card and in the document

### Requirement: Team graph is read-only in v1

The studio's team view SHALL render members, parent relationships, and orchestration edges as a read-only graph in its first version. Membership SHALL be editable through the three-bucket cards and the roster; orchestration edges SHALL be displayed but not authored from the graph. Writable edge authoring SHALL be out of scope for this capability's first version.

#### Scenario: Team graph reflects the document
- **WHEN** the document's team block declares members and edges
- **THEN** the graph renders those members and edges, and the graph provides no affordance to add or remove edges

### Requirement: AI draft actions produce editable drafts, never direct writes

The studio SHALL offer AI draft actions that reuse the existing in-chat builder tool faces (the architect/author personas) to propose content for the current agent. An AI draft SHALL land in the canvas as an editable draft, and SHALL NOT be written to any emit target without an explicit user action.

#### Scenario: AI proposes a draft
- **WHEN** the user invokes an AI draft action for the selected agent
- **THEN** the proposed persona/skills/MCP appear as an editable draft on the canvas and no artifact is created until the user emits

### Requirement: Live validation uses the existing single validator

The preview pane SHALL surface validation results from the platform's existing content validators (the pack manifest validator, the fleet-template parser, and the tool-face closure gate), reported with the validators' own field-level errors. The studio SHALL NOT introduce a second validator or restate validator errors in its own words.

#### Scenario: Invalid draft is shown before emit
- **WHEN** the working document has an invalid skill name or an unresolvable MCP reference
- **THEN** the preview pane lists the validator's field-level errors and the emit actions remain blocked until they are resolved

### Requirement: Emit to preset and pack draft, re-validated at emit

The studio SHALL support emitting the working document to two targets in this capability's first version: a **cell-local personal preset** and a **pack draft** that enters the existing market publish gate. Every emit SHALL re-validate the document through the existing validator set and SHALL refuse emission on validation failure. Emission SHALL NOT mutate the working document.

#### Scenario: Emit a personal preset
- **WHEN** the user emits a valid document as a personal preset
- **THEN** a cell-local preset is created with no publish gate, and the working document is unchanged

#### Scenario: Emit a pack draft
- **WHEN** the user emits a valid document as a pack draft
- **THEN** a draft enters the existing publish gate, and an invalid document is refused with the validator's errors

### Requirement: The studio does not bypass lifecycle gates

The studio SHALL only produce artifacts through the existing lifecycles: presets remain cell-local, pack drafts remain subject to the publish gate and version immutability, and any later target (team template, blueprint) SHALL enter its own lifecycle pipeline rather than being written directly by the studio.

#### Scenario: Studio emission respects the pack gate
- **WHEN** the user emits a pack draft from the studio and then attempts to publish
- **THEN** publishing still passes the existing publish gate, rate limiting, and manifest validation
