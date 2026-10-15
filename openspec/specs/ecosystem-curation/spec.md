# ecosystem-curation Specification

## Purpose
开源素材（MCP server 与技能）进入谦面货架的治理面：只有过审的素材进场、托管姿态统一、来源与许可证对外可见——让「精选」本身成为店的品质承诺。

## Requirements

### Requirement: Ecosystem material enters only through curation review

Open-source material — MCP servers and skills — SHALL become visible in the registry catalog and the marketplace only after passing a documented curation review covering security, license, and quality. Unreviewed or rejected material SHALL NOT be installable, listable, or referenceable by pack manifests. Rejection SHALL be recorded with the failing axis named.

#### Scenario: Unreviewed server is invisible

- **WHEN** an open-source MCP server is hosted but has not completed curation review
- **THEN** it is absent from every catalog listing and a pack manifest referencing it is rejected

#### Scenario: License landmine is rejected at review

- **WHEN** a candidate server or skill carries a license the review policy excludes (e.g. AGPL for hosted servers, non-commercial terms)
- **THEN** the entry is rejected with the license axis named and is not hosted or listed

### Requirement: Curated MCP servers run platform-hosted with a per-server egress posture

Every curated open-source MCP server SHALL run platform-hosted in its own container on the existing server hosting pattern, registered in the registry, proxied through the registry gateway like every other server. Each server's outbound network access SHALL be an explicit per-server allowlist decided at review (fetch/browse-class servers may egress broadly; the rest default to denied). No platform credential SHALL be injected into any curated server's environment.

#### Scenario: Curated server is reachable like an owned server

- **WHEN** a user with the required scope calls a curated server through the registry gateway
- **THEN** the call is proxied to the platform-hosted container and behaves like any registered server

#### Scenario: No platform credentials in curated containers

- **WHEN** a curated server's container environment is inspected
- **THEN** it contains no platform credential material (registry admin tokens, sub2api keys, relay secrets)

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

### Requirement: No open submission surface

Open-source material SHALL NOT enter the curated registry catalog or curated marketplace through any user-facing submission surface: no public endpoint or UI SHALL offer submission of skills or MCP servers into the curated listings. Operator-side ingestion tooling (scripts, admin endpoints) MAY exist but SHALL require operator authentication. The external-source mirror shelf (openspec: external-skill-sources) is a NAMED SEPARATE SURFACE and is not part of the curated marketplace: its entries bypass curation by definition, are marked as not reviewed by this platform, and their existence SHALL NOT alter curated-listing admission, ordering, or display rules.

#### Scenario: No public upload path exists

- **WHEN** an external user looks for a way to submit their own MCP server or skill to the marketplace
- **THEN** no public endpoint or UI offers submission, and documentation points to the curated intake process instead

#### Scenario: public submission attempt is refused

- **WHEN** an unauthenticated or non-operator user posts skill content to any curation endpoint
- **THEN** the request is refused with an operator-authentication error and no curated entry is created

#### Scenario: curated rules are untouched by the mirror shelf

- **WHEN** the external-source mirror shelf is enabled and displaying entries
- **THEN** the curated skills and MCP listings, their ordering, and their admission rules are byte-identical to their behavior with the shelf disabled

#### Scenario: mirror entries never leak into curated listings

- **WHEN** a user browses the curated skills catalog or MCP market
- **THEN** no external-mirror entry appears there, and pack manifests cannot reference mirror-only entries
