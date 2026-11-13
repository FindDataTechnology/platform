## MODIFIED Requirements

### Requirement: Ecosystem entries carry provenance and license marks

Every ecosystem skill and curated server entry SHALL carry its upstream source repository and license, visible in catalog listings and pack detail views. The mark SHALL distinguish ecosystem entries from FindData official entries; the distinction is provenance, not a quality grade. The same provenance marks SHALL render on the facet surface's infrastructure views: an ecosystem skill's entry in the facet skills catalog and a curated server's depth view (openspec: facet-platform, MCP catalog cards on the facet surface). A registry entry whose upstream source or license was not declared SHALL render an explicit not-declared mark on those surfaces, never a blank area and never an invented value.

#### Scenario: Ecosystem skill shows its source

- **WHEN** a user opens an ecosystem skill's entry in the skills catalog
- **THEN** the upstream repository and license are visible alongside the skill

#### Scenario: Official and ecosystem entries are distinguishable

- **WHEN** a listing mixes FindData official and ecosystem entries
- **THEN** each entry's provenance mark says which kind it is

#### Scenario: Provenance renders on the facet infrastructure views

- **WHEN** a visitor opens an ecosystem skill's entry in the facet skills catalog, or a curated server's depth view on the facet surface
- **THEN** the upstream repository (skill) or provider organization (server) and the license render alongside the entry, with the ecosystem-vs-official distinction visible

#### Scenario: Undeclared provenance renders honestly

- **WHEN** a registry entry carries no upstream source or no license
- **THEN** the facet surfaces render an explicit not-declared mark for that field, never an empty area and never an invented value
