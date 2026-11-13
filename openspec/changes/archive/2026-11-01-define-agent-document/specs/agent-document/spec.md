## Purpose

The single composition model the platform builds, displays, distributes and deploys from: an agent is its three content buckets (persona, skills, MCP tools) plus optional envelope fields, and a team is that model plus an organization block — one document, several emit targets, never several models.

## ADDED Requirements

### Requirement: Agent Document is the atomic composition unit

The system SHALL represent an agent as exactly three content buckets — **persona** (role text and operating discipline), **skills** (inline SKILL bodies), and **mcp** (registry-name references, optionally narrowed by a tool allowlist) — and SHALL treat these three as one indivisible unit of authorship and display. A document SHALL carry one or more agents. When the document describes a team it SHALL add a `fleet` organization block (members, edges, cadence, KPI slots). Envelope fields — `guide`, `i18n`, `provenance`, `serving`, `bots`, `visibility`, `tags`, `category` — SHALL be optional and SHALL NOT redefine the three buckets. The document shape SHALL be the existing pack manifest; this capability names and bounds it, and SHALL NOT introduce a second content shape.

#### Scenario: Single-agent document
- **WHEN** a document declares one agent with a persona, one skill, and one MCP reference
- **THEN** it is a complete Agent Document and is eligible for every emit target that does not require an organization block

#### Scenario: Team document
- **WHEN** a document declares multiple agents plus a `fleet` block
- **THEN** it is a team-shaped Agent Document, and the `fleet` members reference agents within the same document

### Requirement: Every emit target validates through the single existing validator

All emit targets SHALL validate the Agent Document through the platform's existing content validators (the pack manifest validator and the fleet-template parser), and the system SHALL NOT introduce a second content validator. A document that fails validation SHALL be rejected at every emit target with the validator's own field-level errors, not a target-specific restatement. Emit-time validation SHALL be defense in depth and SHALL NOT rely solely on compose-time validation.

#### Scenario: Invalid document is rejected at emit
- **WHEN** a document carries an invalid skill name or an out-of-set MCP reference and the user attempts to emit it
- **THEN** the emit is refused with the existing validator's field-level error text and no artifact is produced

#### Scenario: One document, identical validation across targets
- **WHEN** the same valid document is emitted to two different targets
- **THEN** both emissions pass the same validator and neither target applies a relaxed or target-specific rule set

### Requirement: Four emit targets produce defined artifacts from one document

The system SHALL support four emit targets from a single Agent Document: **personal preset** (cell-local, no publish gate), **pack draft** (enters the market publish gate), **fleet template** (enters template instantiation/deploy), and **blueprint** (enters the approve/cast/iterate pipeline). Each emit target SHALL re-validate at emit time and SHALL produce an artifact of its own declared lifecycle; the document itself SHALL NOT be mutated by an emit.

#### Scenario: Emit to a cell-local preset
- **WHEN** a document is emitted as a personal preset
- **THEN** the preset is stored cell-locally with no publish gate and is not visible to other users

#### Scenario: Emit to a pack draft
- **WHEN** a document is emitted as a pack draft
- **THEN** it enters the existing publish gate and, on publish, becomes a versioned market entry subject to the marketplace's immutability rules

#### Scenario: Emit to a blueprint
- **WHEN** a document is emitted as a blueprint
- **THEN** it enters the existing validate → approve → cast → iterate pipeline and SHALL NOT be castable before approval

### Requirement: Editor convergence SHALL NOT converge lifecycles

The platform MAY provide a single composition editor for all four emit targets, but the four lifecycles SHALL remain distinct: the blueprint approve → cast → iterate pipeline, pack version immutability, cell-local preset residency, and template instantiation SHALL each retain their existing rules. Merging the editing surface SHALL NOT merge, weaken, or bypass any lifecycle gate.

#### Scenario: One editor, four lifecycles
- **WHEN** a single composition editor is used to produce a preset, a pack, a template, and a blueprint
- **THEN** each artifact still obeys its own lifecycle — e.g. a blueprint still requires approval before cast, and a published pack version remains immutable

### Requirement: Agent-presenting surfaces render the three buckets as one unit

Any surface that presents an agent to a user — market detail, official gallery, conversation picker — SHALL be able to render the agent's persona, skills, and MCP tool face as one unit (a spec sheet), alongside its derived type badge and provenance. The three buckets SHALL be individually inspectable. An agent whose skills or MCP references are empty SHALL still present the bucket as empty rather than hiding the three-bucket structure.

#### Scenario: Market detail shows the three buckets
- **WHEN** a user inspects an agent in the market detail
- **THEN** the persona, the skills list, and the MCP references (with their tool face) render together as one spec sheet, with the type badge and provenance

#### Scenario: Empty bucket stays visible
- **WHEN** an agent declares a persona but no skills and no MCP references
- **THEN** the spec sheet renders the skills and MCP buckets as explicitly empty, not omitted

### Requirement: Agent Document carries no endpoints or credentials

No Agent Document SHALL carry an endpoint, credential, secret, or credential-like literal in any bucket or envelope field, in any emit target. Every emit target SHALL reject such material at write time; the document's MCP references SHALL remain registry-name references only, and serving contracts SHALL remain declarations (protocol, optional model constraints, budget) rather than runtime configuration.

#### Scenario: Credential material is rejected
- **WHEN** a document includes a token, endpoint URL, or secret-like literal in any bucket or envelope field
- **THEN** every emit target rejects it with a field-level error and stores nothing
