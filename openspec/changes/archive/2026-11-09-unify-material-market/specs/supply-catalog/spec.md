# supply-catalog Specification Delta

## MODIFIED Requirements

### Requirement: One catalog read path for six species

The facet catalog API family SHALL be the single catalog read path for all six material species — `pack`, `skill`, `mcp`, `facade`, `data-anchor`, `plugin` — whose enumeration is versioned: new species extend the enumeration with a version bump and never overload an existing value. This change is the first exercise of that rule: `plugin` is the sixth species, `SUPPLY_SPECIES` gains it as an appended value, and `SUPPLY_SPECIES_VERSION` moves from 1 to 2, while the five existing species values keep their meaning unchanged. Every presenting surface that lists materials (the facet storefront, the 壹座 market cabinets, the plaza export, the machine faces) SHALL read this projection rather than maintaining its own catalog source. The catalog SHALL NOT restate or reinterpret admission: each species admits through its own source of truth (packs via the market listing rule, skills and MCP servers via registry visibility, facades via the deployments public face, data anchors via the DAAS catalog face, plugins via the dsh plugin catalogue — the operator-curated list of harness plugins, reviewed under the ecosystem curation runbook and ledger).

For the `plugin` species the source of truth SHALL be that curated catalogue, NOT package-manager metadata at runtime: the catalog SHALL NOT enumerate an installed module tree, a lockfile, or any package registry reachable from a running profile, and a catalogued plugin SHALL NOT be reported as supplied or installed merely because it appears in the catalogue. A catalogued plugin's presence in the enumeration SHALL mean "the operator has reviewed and may offer this plugin", never "this deployment runs it".

#### Scenario: Cabinet and plaza agree on the catalog

- **WHEN** the same material is listed through the 壹座 market cabinets and through the plaza export in the same refresh window
- **THEN** both surfaces render it from the unified catalog projection with the same name, description, and provenance, and neither carries an entry the other cannot trace to the projection

#### Scenario: Species enumeration extension bumps the version

- **WHEN** the species enumeration is extended with `plugin` as the sixth material species
- **THEN** the catalog species enumeration SHALL report version 2 and the `plugin` value SHALL be present alongside the five existing values
- **AND** the values `pack`, `skill`, `mcp`, `facade`, and `data-anchor` SHALL keep their meaning unchanged

#### Scenario: v2 enumeration serves six species and a branchable version

- **WHEN** a client reads the species enumeration route `/api/supply-catalog/species`
- **THEN** the response SHALL list exactly six species and report version 2
- **AND** a client written against version 1 SHALL be able to branch on the reported version number instead of assuming a five-species enumeration

### Requirement: Annotation shape spans all species

Every catalog entry for every species SHALL carry the production annotation-layer shape — `canonical.brief`, `human` in the five locale slots, `whenToUse`, and `provenance` with `source` and `updatedAt` — using the same field names the platform's own surfaces use, with no new vocabulary. An entry not yet covered by an annotation pass SHALL carry its zh source text in all five locale slots with provenance unchanged, never machine-translated and never omitted.

A `plugin` entry SHALL carry that same shape and, for this species only, an additive field set: the supply state (whether the current deployment supplies the plugin) and the review provenance recorded in the curation ledger (`reviewedAt`, `reviewer`, and the licence identifier). These fields are additive annotations on the plugin entry, not new vocabulary for the other species: consumers that read only the shared shape SHALL still read a valid plugin entry, and the annotation shape of the other five species SHALL NOT change or gain required fields.

#### Scenario: A facade entry carries the annotation shape

- **WHEN** a catalog consumer reads a facade entry from the catalog API family
- **THEN** the entry has a canonical brief, five locale slots, a whenToUse hint, and provenance naming its source and as-of date

#### Scenario: Un-annotated data anchors are honest

- **WHEN** a data-anchor entry has no annotation coverage
- **THEN** its entry carries the zh source text in all five locale slots and provenance still names the DAAS catalog and as-of date

#### Scenario: A plugin entry carries the annotation shape plus review provenance

- **WHEN** a catalog consumer reads a plugin entry from the catalog API family
- **THEN** the entry SHALL have a canonical brief, five locale slots, a whenToUse hint, and provenance naming its source and as-of date, exactly as the other species do
- **AND** the entry SHALL additionally carry the supply state and the ledger review provenance (`reviewedAt`, `reviewer`, licence identifier)
- **AND** no entry of the other five species SHALL be required to carry those additive fields

## RENAMED Requirements

- FROM: `### Requirement: One catalog read path for five species`
- TO: `### Requirement: One catalog read path for six species`
