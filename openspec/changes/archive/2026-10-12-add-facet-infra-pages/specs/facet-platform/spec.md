## MODIFIED Requirements

### Requirement: MCP catalog cards on the facet surface

The facet surface SHALL present the registry's MCP servers as cards — name, description, connection endpoint reference, required group when present — aggregated read-only from the registry (openspec: registry-market-deployment), honoring the same visibility gating the registry enforces for the viewing identity. Each card SHALL open a per-server depth view carrying: the server's tool surface (each tool's name and description, as stored on the registry entry; a server whose tool snapshot is absent renders an explicit "not captured" note rather than an empty list), its provenance (license and provider organization when the registry entry carries them; an entry without them SHALL render an explicit "not declared" mark, never an invented value), its required group and hosting tier as declared, and its endpoint with the connection essentials. The depth data SHALL load on demand — the card list payload SHALL NOT carry the tool surface. The facet surface SHALL NOT modify registry entries; the registry's software, domain, and deployment location are unchanged (ADR-0015).

The facet surface SHALL additionally present a skills catalog: the registry's skills as a browsable listing — name, description, upstream source repository when declared, author when declared, tags — under the same visibility gating (public entries visible anonymously; group-gated entries visible to a viewer whose identity carries a matching group). The skills listing SHALL carry the provenance marks openspec: ecosystem-curation promises (upstream repository and license visible; ecosystem vs FindData-official distinguishable), and SHALL be read-only like the MCP surface.

#### Scenario: Visible MCP servers appear as cards

- **WHEN** a visitor opens the facet surface's MCP section
- **THEN** registry MCP servers visible to that identity are listed as cards with their endpoint reference

#### Scenario: Cards are read-only

- **WHEN** the facet surface is used by any identity
- **THEN** no registry entry is created, modified, or deleted through it

#### Scenario: The depth view carries the tool surface and provenance

- **WHEN** a visitor opens a server's depth view
- **THEN** every captured tool renders with its name and description, and the license, provider organization, required group, and endpoint render as declared on the registry entry

#### Scenario: Missing metadata renders honestly

- **WHEN** a server's registry entry has no license, no provider organization, or no captured tool snapshot
- **THEN** the depth view renders an explicit not-declared / not-captured mark for that field, never an empty area and never an invented value

#### Scenario: The tool surface is loaded on demand

- **WHEN** a visitor opens the MCP section without opening any depth view
- **THEN** the card list renders without the tool surfaces; opening a depth view loads that server's tools

#### Scenario: Skills render with provenance

- **WHEN** a visitor opens the skills catalog
- **THEN** each visible skill renders with its description, upstream repository and author when declared, and tags; ecosystem entries are distinguishable from FindData-official entries by their provenance mark

#### Scenario: Skills gating follows the viewer's identity

- **WHEN** an anonymous visitor and a viewer with a required group each open the skills catalog
- **THEN** public skills appear for both, and group-gated skills appear only for the viewer whose identity carries a matching group

#### Scenario: The skills surface is read-only

- **WHEN** the facet surface's skills catalog is used by any identity
- **THEN** no registry skill entry is created, modified, or deleted through it

### Requirement: Shell views are addressable hash routes

The facet web shell SHALL address its views by hash: `#/` (intro) as the default landing, `#/packs` (packs market), `#/mcp` (MCP service catalog, carrying the per-server depth views and the skills catalog), plus identity-conditional views — `#/mine` (creator console, visible to signed-in users) and `#/curate` (curation board, visible to admins). The tab control and the hash SHALL stay in sync in both directions: switching tabs updates the hash, and loading or navigating to a hash renders the matching view with its tab active. An unknown or empty hash SHALL fall back to `#/`, and the shell SHALL add no router dependency. A view the shell borrows from the 壹座 web app SHALL render completely on the facet shell without any routing-context ancestor; a host-side navigation affordance that only makes sense inside 壹座 SHALL be suppressible by the shell without altering the borrowed view's data behavior. A conditional view's tab SHALL appear only when the viewer's identity grants it; navigating to a conditional hash without the grant SHALL fall back to the intro landing (the data plane rejects the calls anyway). Depth views SHALL remain reachable within `#/mcp` without adding new top-level hashes.

#### Scenario: deep link and refresh

- **WHEN** a visitor opens `#/mcp` directly, or reloads while on `#/packs`
- **THEN** the matching view renders with its tab active

#### Scenario: tab and hash stay in sync

- **WHEN** a visitor switches to the packs market tab
- **THEN** the location hash becomes `#/packs` and a reload keeps that view

#### Scenario: unknown hash falls back

- **WHEN** the location hash is unknown or empty
- **THEN** the intro view renders as the landing

#### Scenario: borrowed view needs no routing context

- **WHEN** the packs market view mounts on the facet shell and public packs exist
- **THEN** pack cards render and the view is interactive (search, detail dialog)
- **AND** no routing provider is present anywhere in the facet shell, and no host-only navigation affordance renders

#### Scenario: conditional tabs follow identity

- **WHEN** an anonymous visitor, a signed-in creator, and an admin each load the shell
- **THEN** the anonymous visitor sees only the three public tabs; the creator additionally sees the creator-console tab (`#/mine`); the admin additionally sees the curation tab (`#/curate`)

#### Scenario: depth views stay inside the mcp hash

- **WHEN** a visitor opens a server's depth view or the skills catalog
- **THEN** the view renders within `#/mcp` (no new top-level hash is introduced), and a reload on `#/mcp` returns to the catalog
