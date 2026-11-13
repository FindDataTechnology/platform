# ecosystem-curation Specification

## Purpose

开源素材（MCP server 与技能）进入谦面货架的治理面：只有过审的素材进场、托管姿态统一、来源与许可证对外可见——让「精选」本身成为店的品质承诺。

## ADDED Requirements

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

Every ecosystem skill and curated server entry SHALL carry its upstream source repository and license, visible in catalog listings and pack detail views. The mark SHALL distinguish ecosystem entries from FindData official entries; the distinction is provenance, not a quality grade.

#### Scenario: Ecosystem skill shows its source

- **WHEN** a user opens an ecosystem skill's entry in the skills catalog
- **THEN** the upstream repository and license are visible alongside the skill

#### Scenario: Official and ecosystem entries are distinguishable

- **WHEN** a listing mixes FindData official and ecosystem entries
- **THEN** each entry's provenance mark says which kind it is

### Requirement: No open submission surface

The marketplace and registry SHALL expose no public channel for submitting third-party material; curation intake is operator-side. There is exactly one tier for ecosystem material (curated); no community tier exists in this version.

#### Scenario: No public upload path exists

- **WHEN** an external user looks for a way to submit their own MCP server or skill to the marketplace
- **THEN** no public endpoint or UI offers submission, and documentation points to the curated intake process instead
