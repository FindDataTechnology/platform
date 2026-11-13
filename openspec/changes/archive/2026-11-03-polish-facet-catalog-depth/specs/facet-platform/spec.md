## MODIFIED Requirements

### Requirement: MCP catalog cards on the facet surface
The facet surface SHALL present the registry's MCP servers as cards — name, description, connection endpoint reference, required group when present — aggregated read-only from the registry (openspec: registry-market-deployment), honoring the same visibility gating the registry enforces for the viewing identity. When a registry entry carries a supply annotation (per `supply-annotation-overlay`), the card SHALL render the annotation's human track for the resolved locale (request `locale` parameter > `Accept-Language` > zh; missing locale falls back to zh, unannotated entries fall back to the stored raw text); the raw stored name and description SHALL remain visible in the depth view. Each card SHALL open a per-server depth view carrying: the server's tool surface (each tool's name and description, as stored on the registry entry; when a tool carries an annotation, its localized human label and summary SHALL render alongside the raw name and the raw name SHALL NOT be replaced; a server whose tool snapshot is absent renders an explicit "not captured" note rather than an empty list), its provenance (license and provider organization when the registry entry carries them; an entry without them SHALL render an explicit "not declared" mark, never an invented value), its required group and hosting tier as declared, and its endpoint with the connection essentials. The catalog and depth data SHALL be fetched with an explicit `locale` parameter derived from the surface's own locale selection, and a locale change SHALL refetch the data — the annotation language SHALL follow the user's chosen locale, not merely the browser's `Accept-Language`. The depth data SHALL load on demand — the card list payload SHALL NOT carry the tool surface. On large tool surfaces the depth view SHALL present tools in a space-efficient multi-column layout with per-tool descriptions constrained to a readable preview that expands on demand, and SHALL offer client-side filtering and grouping by tool-name prefix (a zero-data signal) — scanability governs density; localized annotation labels lead where present and the raw name SHALL remain visible. The facet surface SHALL NOT modify registry entries; the registry's software, domain, and deployment location are unchanged (ADR-0015).

The facet surface SHALL additionally present a skills catalog: the registry's skills as a browsable listing — name, description, upstream source repository when declared, author when declared, tags — under the same visibility gating (public entries visible anonymously; group-gated entries visible to a viewer whose identity carries a matching group). When a skill carries a supply annotation, its human track SHALL render for the resolved locale with the same fallback chain; unannotated skills render their stored raw text. The skills listing SHALL carry the provenance marks openspec: ecosystem-curation promises (upstream repository and license visible; ecosystem vs FindData-official distinguishable), and SHALL be read-only like the MCP surface.

#### Scenario: Visible MCP servers appear as cards

- **WHEN** a visitor opens the facet surface's MCP section
- **THEN** registry MCP servers visible to that identity are listed as cards with their endpoint reference

#### Scenario: Cards are read-only

- **WHEN** the facet surface is used by any identity
- **THEN** no registry entry is created, modified, or deleted through it

#### Scenario: The depth view carries the tool surface and provenance

- **WHEN** a visitor opens a server's depth view
- **THEN** every captured tool renders with its name and description, and the license, provider organization, required group, and endpoint render as declared on the registry entry

#### Scenario: Annotated entries render the resolved locale

- **WHEN** a visitor requests the catalog with `locale=en` for a server whose annotation carries zh and en tracks
- **THEN** the card renders the en human name and summary
- **WHEN** the same entry is requested with `locale=ja`
- **THEN** the card renders the zh track (no third-language fallback)

#### Scenario: Unannotated entries render byte-identical

- **WHEN** a visitor opens the catalog with any locale for an entry without annotations
- **THEN** the rendered name and description equal the stored raw text, exactly as before the annotation layer existed

#### Scenario: Missing metadata renders honestly

- **WHEN** a server's registry entry has no license, no provider organization, or no captured tool snapshot
- **THEN** the depth view renders an explicit not-declared / not-captured mark for that field, never an empty area and never an invented value

#### Scenario: The tool surface is loaded on demand

- **WHEN** a visitor opens the MCP section without opening any depth view
- **THEN** the card list renders without the tool surfaces; opening a depth view loads that server's tools

#### Scenario: Locale switch refetches data in the chosen locale

- **WHEN** a visitor whose browser prefers Chinese switches the surface locale to English
- **THEN** the catalog and depth data are refetched with `locale=en` and annotated entries render their English human track — chrome and data flip together

#### Scenario: Large tool surfaces group and filter

- **WHEN** a depth view carries a tool surface of over fifty tools
- **THEN** tools render in a multi-column layout grouped by name prefix with a client-side filter, and the filter narrows the list as the visitor types

#### Scenario: Long descriptions fold and expand

- **WHEN** a tool's description (annotated summary or raw text) exceeds the preview constraint
- **THEN** it renders clamped with an expand affordance; expanding reveals the full text and the raw name stays visible throughout

#### Scenario: Skills render with provenance

- **WHEN** a visitor opens the skills catalog
- **THEN** each visible skill renders with its description, upstream repository and author when declared, and tags; ecosystem entries are distinguishable from FindData-official entries by their provenance mark

#### Scenario: Skills gating follows the viewer's identity

- **WHEN** an anonymous visitor and a viewer with a required group each open the skills catalog
- **THEN** public skills appear for both, and group-gated skills appear only for the viewer whose identity carries a matching group

#### Scenario: The skills surface is read-only

- **WHEN** the facet surface's skills catalog is used by any identity
- **THEN** no registry skill entry is created, modified, or deleted through it