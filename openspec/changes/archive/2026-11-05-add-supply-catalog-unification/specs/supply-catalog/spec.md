## Purpose

The unified supply catalog: one catalog read path for the five material species (pack, skill, mcp, facade, data-anchor) served by the facet catalog API family, with the annotation layer spanning all species, the facade and data-anchor species fed by their own sources of truth instead of pack-badge derivation, and offline catalog copies demoted to generated artifacts of the export pipeline.

## ADDED Requirements

### Requirement: One catalog read path for five species

The facet catalog API family SHALL be the single catalog read path for all five material species — `pack`, `skill`, `mcp`, `facade`, `data-anchor` — whose enumeration is versioned: new species extend the enumeration with a version bump and never overload an existing value. Every presenting surface that lists materials (the facet storefront, the 壹座 market cabinets, the plaza export, the machine faces) SHALL read this projection rather than maintaining its own catalog source. The catalog SHALL NOT restate or reinterpret admission: each species admits through its own source of truth (packs via the market listing rule, skills and MCP servers via registry visibility, facades via the deployments public face, data anchors via the DAAS catalog face).

#### Scenario: Cabinet and plaza agree on the catalog

- **WHEN** the same material is listed through the 壹座 market cabinets and through the plaza export in the same refresh window
- **THEN** both surfaces render it from the unified catalog projection with the same name, description, and provenance, and neither carries an entry the other cannot trace to the projection

#### Scenario: Species enumeration extension bumps the version

- **WHEN** a sixth material species is introduced in a later change
- **THEN** the catalog species enumeration carries a higher version number and existing species values keep their meaning unchanged

### Requirement: Annotation shape spans all species

Every catalog entry for every species SHALL carry the production annotation-layer shape — `canonical.brief`, `human` in the five locale slots, `whenToUse`, and `provenance` with `source` and `updatedAt` — using the same field names the platform's own surfaces use, with no new vocabulary. An entry not yet covered by an annotation pass SHALL carry its zh source text in all five locale slots with provenance unchanged, never machine-translated and never omitted.

#### Scenario: A facade entry carries the annotation shape

- **WHEN** a catalog consumer reads a facade entry from the catalog API family
- **THEN** the entry has a canonical brief, five locale slots, a whenToUse hint, and provenance naming its source and as-of date

#### Scenario: Un-annotated data anchors are honest

- **WHEN** a data-anchor entry has no annotation coverage
- **THEN** its entry carries the zh source text in all five locale slots and provenance still names the DAAS catalog and as-of date

### Requirement: The facade species is fed by instance truth

Facade entries in the catalog SHALL derive from deployment/instance records on the deployments face — not from pack badges or name heuristics. Only publicly shared facades SHALL be visible to anonymous identities. Live instance status reported by the serving plane SHALL be included when present; a facade whose status is not reported SHALL render an explicit unknown status mark, never an invented value. The badge-derived facade derivation path SHALL be retired.

#### Scenario: A deployed public facade appears

- **WHEN** a pack is deployed as a publicly shared facade and the catalog refreshes
- **THEN** a facade entry appears with its deployment provenance, and the entry is visible anonymously

#### Scenario: Status missing renders unknown

- **WHEN** a facade entry's live status has not been reported by the serving plane
- **THEN** the entry carries an explicit unknown status mark rather than a defaulted healthy value

#### Scenario: Badge-derived facades disappear

- **WHEN** a pack carries a facade or assistant badge but has no deployment record
- **THEN** no facade entry appears for it in the catalog

### Requirement: The data-anchor species is fed by the DAAS catalog face

Data-anchor entries SHALL be ingested from the DAAS catalog face, with v1 scope limited to catalog classes (entities and indicators); observation series SHALL be excluded. Each entry's provenance SHALL name the DAAS catalog and its as-of date. The heuristic derivation of official-data entries from pack names, badges, or category strings SHALL be retired.

#### Scenario: Anchor provenance is traceable

- **WHEN** a catalog consumer reads a data-anchor entry
- **THEN** its provenance names the DAAS catalog and carries the as-of date of the ingestion

#### Scenario: Heuristic anchors disappear

- **WHEN** a pack whose name matches data-ish patterns has no DAAS catalog backing
- **THEN** no data-anchor entry is derived from it

### Requirement: Offline catalog copies are generated artifacts

Any catalog copy bundled with 壹座 for offline or self-hosted deployments SHALL be a generated artifact of the export pipeline run against the unified catalog — carrying an as-of stamp and provenance — and SHALL be served only when no catalog URL is configured. Hand-curated catalog entries SHALL NOT exist, and no merge or collision rule SHALL apply to the catalog species: with a catalog URL configured, the online projection is the single truth; without one, the generated snapshot serves alone with its staleness visible. (The app-shipped stdio starter floor is not a catalog copy and rides every served market regardless — openspec: extension-marketplace.)

#### Scenario: Unconfigured deployment serves the generated snapshot

- **WHEN** 壹座 starts with no catalog URL configured
- **THEN** the market serves the generated offline snapshot and its as-of stamp is visible to the operator

#### Scenario: No hand-edited entries survive

- **WHEN** the export pipeline regenerates the offline snapshot
- **THEN** the snapshot's entries are exactly the unified catalog's projection at the as-of time, with no locally added, removed, or overridden entries
