## RENAMED Requirements

### Requirement: The inventory spans the three material species

- FROM: `The inventory spans the three material species`
- TO: `The inventory spans the five material species`

## MODIFIED Requirements

### Requirement: Each species admits through its own registry's public face

The plaza export SHALL admit each species through that species' own source-of-truth public face — packs through the market listing rule (public, non-unlisted, curated — or the operator whitelist replacing curation outright), skills and MCP servers through the registry visibility rule (no required groups = public; group-gated entries never appear anonymously), facades through the deployments public face (only publicly shared facades admit; instance status reported by the serving plane is included when present and rendered as an explicit unknown when absent), and data anchors through the DAAS catalog face (v1 scope: catalog classes; provenance names the DAAS catalog). The export SHALL NOT restate or reinterpret any admission predicate, and SHALL NOT derive a species from another species' badges, names, or category strings. A reconciliation gate SHALL compare the exported catalog's per-species material count with each source's count at export time and fail the build on any mismatch.

#### Scenario: Private, unlisted, and group-gated materials never appear

- **WHEN** the export runs against sources containing private packs, unlisted packs, group-gated MCP servers, and non-public facades
- **THEN** none of them appear in any machine surface or human gallery — byte-identical to what the anonymous browse faces show

#### Scenario: Per-source count reconciliation gate

- **WHEN** any species' exported count differs from its source's count at export time
- **THEN** the export fails naming the species and both counts, and no artifacts are written

#### Scenario: Badge-derived species entries are gone

- **WHEN** a pack carries a facade/assistant badge or a data-ish name but its species' own source has no corresponding record
- **THEN** no facade or data-anchor entry is derived from that pack, and the reconciliation gate counts only source-admitted entries

### Requirement: The inventory spans the three material species

The export SHALL ingest all five material species: packs from the market listing, skills from the skills catalog, MCP servers from the MCP catalog, facades from the deployments public face, and data anchors from the DAAS catalog face. Each MCP server's material page SHALL embed its full public tool surface (tool names and descriptions, tool count, license and provider where exposed) rather than splitting tools into separate pages. Each pack's material page SHALL enumerate the skills and MCP server references declared in its own manifest, so the contents inside 壹座 packs are themselves visible. Each facade's material page SHALL state its deployment provenance and its live status as reported (or an explicit unknown mark). Each data anchor's material page SHALL state its DAAS catalog provenance and as-of date.

#### Scenario: Skills and MCP species are populated

- **WHEN** the export completes with all five sources reachable
- **THEN** `catalog.json` carries nonzero entries for all five species — packs, skills, MCP servers, facades, data anchors — each with a stable species-appropriate address, and the hero counts agree with the catalog

#### Scenario: Facade and data-anchor species are populated by their sources

- **WHEN** the export completes with all five sources reachable
- **THEN** `catalog.json` carries facade and data-anchor entries admitted by their own source faces alongside packs, skills, and MCP servers, each with a stable species-appropriate address

#### Scenario: MCP material page embeds the tool surface

- **WHEN** a reader opens an MCP server's material page
- **THEN** the page lists every public tool with its description and the total tool count, self-contained with provenance

#### Scenario: Pack page enumerates its own contents

- **WHEN** a reader opens a pack's material page
- **THEN** the page names the skills and MCP server references the pack's manifest declares, in addition to the obtain paths

#### Scenario: Facade page is honest about status

- **WHEN** a reader opens a facade's material page whose live status has not been reported
- **THEN** the page renders an explicit unknown status mark rather than a defaulted value
