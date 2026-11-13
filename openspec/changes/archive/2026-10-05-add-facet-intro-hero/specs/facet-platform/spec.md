## ADDED Requirements

### Requirement: The facet web shell carries a product intro band

The facet web shell SHALL render a static intro band between the header and the
tab content, present on both tabs (packs market and MCP catalog), always
visible and not dismissible. The band SHALL carry the dual-layer pitch: one
value-positioning line for the facet line, and quick facts limited to
verifiable facts — browse/subscribe/publish, the MCP service catalog, and the
published CLI one-liner `npx @finddatatechonology/facet install <pack id>`
(the same fact the packs footnote used to carry; the footnote now points at
`facet help` — single source, no counts or claims not verifiable at build
time). Copy SHALL come from i18n keys authored in all five locales (en is the
source of truth; `scripts/check-locales.js` enforces key-set parity, so
"fallback" is a safety net, not the authoring mode), and the band SHALL link
the official site's facet line page following the active locale
(`/zh/products/facet` under zh, `/products/facet` otherwise). The band SHALL
stay compact so market cards remain above the fold, and SHALL add no new
view, route, or interactive state.

#### Scenario: intro band on both tabs

- **WHEN** a visitor opens the facet domain and switches between the packs and MCP tabs
- **THEN** the intro band remains rendered above the tab content, in the active locale

#### Scenario: CLI fact stays verifiable and single-sourced

- **WHEN** the band renders the install command
- **THEN** it shows the published package name and install form only, matching the footer hint's fact, with the footer duplicate removed or reduced

#### Scenario: line-page backlink follows locale

- **WHEN** the active locale is zh-CN and the visitor follows the band's official-site link
- **THEN** it targets `/zh/products/facet`; under en (or fallback locales) it targets `/products/facet`
