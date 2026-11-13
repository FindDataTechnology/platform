## MODIFIED Requirements

### Requirement: Ecosystem entries carry provenance and license marks

Every ecosystem skill, curated server, and official-adopted Agent entry SHALL carry its upstream source repository and license, visible in catalog listings and pack detail views. The provenance mark SHALL distinguish, as three separate kinds, ecosystem entries (unreviewed upstream material), FindData-original official entries, and official-adopted entries (third-party material reviewed and republished by the operator); the distinction SHALL be provenance, not a quality grade. The same provenance marks SHALL render on the facet surface's infrastructure views: an ecosystem skill's entry in the facet skills catalog, a curated server's depth view, and an adopted Agent's listing and detail (openspec: facet-platform, MCP catalog cards on the facet surface; openspec: official-adoption). A registry entry whose upstream source or license was not declared SHALL render an explicit not-declared mark on those surfaces, never a blank area and never an invented value.

#### Scenario: Ecosystem skill shows its source

- **WHEN** a user opens an ecosystem skill's entry in the skills catalog
- **THEN** the upstream repository and license are visible alongside the skill

#### Scenario: Official and ecosystem entries are distinguishable

- **WHEN** a listing mixes FindData-original official entries, official-adopted entries, and ecosystem entries
- **THEN** each entry's provenance mark says which of the three kinds it is

#### Scenario: Adopted entry shows its upstream and pinned revision

- **WHEN** a user opens an official-adopted Agent's detail view
- **THEN** the upstream source, its license, and the pinned revision are visible alongside the official-adopted mark

#### Scenario: Provenance renders on the facet infrastructure views

- **WHEN** a visitor opens an ecosystem skill's entry in the facet skills catalog, a curated server's depth view, or an official-adopted Agent's listing on the facet surface
- **THEN** the upstream repository (skill) or provider organization (server) and the license render alongside the entry, with the ecosystem-vs-official and official-vs-adopted distinctions visible

#### Scenario: Undeclared provenance renders honestly

- **WHEN** a registry entry carries no upstream source or no license
- **THEN** the facet surfaces render an explicit not-declared mark for that field, never an empty area and never an invented value

### Requirement: No open submission surface

Open-source material SHALL NOT enter the curated registry catalog or curated marketplace through any anonymous user-facing submission surface: no public endpoint or UI SHALL offer submission of skills or MCP servers into the curated listings to anyone who is not a registered vendor (openspec: vendor-identity). Registered vendors MAY submit their own material through the platform's vendor onboarding lane, and every such submission SHALL still pass the curation review (security, license, quality) and the vendor onboarding gate before becoming visible — vendor registration opens a submission path, never a bypass of review. Operator-side ingestion tooling (scripts, admin endpoints) MAY exist but SHALL require operator authentication. An official-adopted Agent SHALL also be an operator-side operation that passes curation review before becoming visible (openspec: official-adoption), and SHALL NOT create a path by which unreviewed material reaches the curated catalog. The external-source mirror shelf (openspec: external-skill-sources) is a NAMED SEPARATE SURFACE and is not part of the curated marketplace: its entries bypass curation by definition, are marked as not reviewed by this platform, and their existence SHALL NOT alter curated-listing admission, ordering, or display rules.

#### Scenario: No public upload path exists

- **WHEN** an external user without a registered vendor binding looks for a way to submit their own MCP server or skill to the marketplace
- **THEN** no public endpoint or UI offers submission, and documentation points to vendor registration plus the curated intake process instead

#### Scenario: public submission attempt is refused

- **WHEN** an anonymous request attempts to submit material into the curated listings
- **THEN** the request is refused and nothing enters curation review

#### Scenario: Vendor submission still passes curation review

- **WHEN** a registered vendor submits an MCP server through the vendor onboarding lane
- **THEN** the submission enters curation review like any operator-ingested material and is invisible in curated listings until the review passes

#### Scenario: adopted material still passes review before visibility

- **WHEN** an operator starts adopting an external skill into an official Agent
- **THEN** the material enters curation review and stays invisible in curated listings until the review passes

#### Scenario: curated rules are untouched by the mirror shelf

- **WHEN** the external mirror shelf is enabled or disabled
- **THEN** the curated skills and MCP listings, their ordering, and their admission rules are byte-identical to their behavior with the shelf disabled

#### Scenario: mirror entries never leak into curated listings

- **WHEN** a user browses the curated skills catalog or MCP market
- **THEN** no entry whose only source is the external mirror shelf appears in the curated listings
