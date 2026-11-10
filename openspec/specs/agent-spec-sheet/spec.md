## Purpose

One shared presentation contract for an agent: persona, skills, and MCP tool face rendered as a single spec sheet with a structurally derived type badge and synthesized provenance, identical across every surface that presents an agent — so official and community agents read the same way everywhere and can be understood rather than only installed.

## Requirements

### Requirement: One shared spec-sheet contract, many surfaces

The system SHALL define a single spec-sheet presentation contract for an agent, consumed by every surface that presents one — at minimum the market detail, the conversation picker, the studio preview pane, and the official gallery. A consuming surface SHALL supply the agent's data and SHALL NOT define its own layout of the three buckets. The same agent SHALL render identically on 壹座 and on the facet (谦面) surface.

#### Scenario: Same agent, same rendering
- **WHEN** the same agent is presented in the market detail on 壹座 and on the facet surface
- **THEN** both render the identical spec sheet, with the same bucket ordering and the same badge and provenance

#### Scenario: A surface supplies data only
- **WHEN** a new surface consumes the spec-sheet contract
- **THEN** it passes the agent's data and renders the shared layout, adding no bucket layout of its own

### Requirement: The three buckets are always rendered, empty included

The spec sheet SHALL always render the three buckets — persona, skills, and MCP tool face — in a fixed order. When a bucket is empty, the spec sheet SHALL present it explicitly as empty rather than omitting it. Each bucket SHALL be individually inspectable: the persona SHALL support a summary with expandable full text, the skills SHALL list names with expandable bodies, and the MCP bucket SHALL list references with their declared tool face (declared count and any narrowed allowlist).

#### Scenario: An agent with only a persona
- **WHEN** an agent declares a persona but no skills and no MCP references
- **THEN** the spec sheet shows the persona bucket with content and shows the skills and MCP buckets explicitly empty

#### Scenario: Full bucket inspection
- **WHEN** a user inspects an agent that declares skills and MCP references
- **THEN** the skills list each name with an expandable body and the MCP bucket lists each reference with its tool face

### Requirement: Type badge is derived, never authored

The type badge on the spec sheet SHALL be derived from the agent document's structure using the platform's existing badge derivation, and SHALL NOT be author-settable or author-overridable. The badge SHALL remain a projection of structure at read time.

#### Scenario: Author cannot set the badge
- **WHEN** an agent document contains a team organization block
- **THEN** the spec sheet shows the blueprint-type badge regardless of any author-supplied type hint

### Requirement: Provenance is synthesized from its three axes

The spec sheet SHALL present provenance synthesized from its three axes — type badge (structure), official status (roster judgment, never the manifest's self-report), and source (manifest provenance) — through the platform's existing single synthesis point. An `official-adopted` source SHALL be shown only when the roster already marks the agent official and the manifest declares the adopted provenance; a manifest self-report alone SHALL never render an agent as official.

#### Scenario: Self-reported official is not official
- **WHEN** a manifest declares official-adopted provenance but the roster does not mark it official
- **THEN** the spec sheet does not present it as official

#### Scenario: Roster-official original
- **WHEN** the roster marks an agent official and the manifest declares official-original
- **THEN** the spec sheet presents the official-original provenance

### Requirement: Guide content comes from the document, not the client

When the agent document carries a usage guide, the spec sheet SHALL render that guide's steps. When it does not, the spec sheet SHALL omit the guide block. The spec sheet SHALL NOT inject guide copy that is not present in the document data.

#### Scenario: Guide present
- **WHEN** the document declares a three-step guide
- **THEN** the spec sheet renders those three steps in document order

#### Scenario: Guide absent
- **WHEN** the document declares no guide
- **THEN** the spec sheet renders no guide block and adds no client-side copy
