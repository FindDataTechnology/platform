## MODIFIED Requirements

### Requirement: No open submission surface

Open-source material SHALL NOT enter the curated registry catalog or curated marketplace through any anonymous user-facing submission surface: no public endpoint or UI SHALL offer submission of skills or MCP servers into the curated listings to anyone who is not a registered vendor (openspec: vendor-identity). Registered vendors MAY submit their own material through the platform's vendor onboarding lane, and every such submission SHALL still pass the curation review (security, license, quality) and the vendor onboarding gate before becoming visible — vendor registration opens a submission path, never a bypass of review. Operator-side ingestion tooling (scripts, admin endpoints) MAY exist but SHALL require operator authentication. The external-source mirror shelf (openspec: external-skill-sources) is a NAMED SEPARATE SURFACE and is not part of the curated marketplace: its entries bypass curation by definition, are marked as not reviewed by this platform, and their existence SHALL NOT alter curated-listing admission, ordering, or display rules.

#### Scenario: No public upload path exists

- **WHEN** an external user without a registered vendor binding looks for a way to submit their own MCP server or skill to the marketplace
- **THEN** no public endpoint or UI offers submission, and documentation points to vendor registration plus the curated intake process instead

#### Scenario: public submission attempt is refused

- **WHEN** an unauthenticated or non-vendor user posts material to any curation or onboarding endpoint
- **THEN** the request is refused with an operator-or-vendor-authentication error and no entry is created

#### Scenario: Vendor submission still passes curation review

- **WHEN** a registered vendor submits an MCP server through the vendor onboarding lane
- **THEN** the submission enters curation review like any operator-ingested material and is invisible in curated listings until the review passes

#### Scenario: curated rules are untouched by the mirror shelf

- **WHEN** the external-source mirror shelf is enabled and displaying entries
- **THEN** the curated skills and MCP listings, their ordering, and their admission rules are byte-identical to their behavior with the shelf disabled

#### Scenario: mirror entries never leak into curated listings

- **WHEN** a user browses the curated skills catalog or MCP market
- **THEN** no external-mirror entry appears there, and pack manifests cannot reference mirror-only entries
