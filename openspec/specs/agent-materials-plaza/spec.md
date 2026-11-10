# Agent Materials Plaza Specification

## Purpose

The Materials Plaza is the outward understanding surface of 壹座·智能体素材广场: a static five-locale site plus machine-readable surfaces that let humans of any language background and AI agents alike understand what infrastructure the platform provides, how it is provided, and which materials exist today — rendered from the registries' own public faces, with the material inventory itself as the site's core.

## Requirements

### Requirement: The human face is a five-locale static site with a fixed narrative structure

The plaza site SHALL be a purely static site serving five locales (zh-CN, en, es, fr, ja) with locale parity enforced by the site-side parity gate. The human face SHALL present, in order: a hero whose primary data is the live material inventory itself — the three species counts (agents/packs, skills, MCP services) plus the tool count and the snapshot as-of date; the five material categories (功能集, 生态技能, MCP 服务, AI 分身, 官方数据锚) as one card each with a concrete example; the supply mechanism chain in four segments (publish → obtain → run → serve) each explained from the material's perspective; a material inventory gallery with species tabs, official/facade badges, category filtering, and search; and a dual audience section (human paths and AI paths) plus the five-line footer ladder with sibling-site links. No locale SHALL fall back to another locale's text on any page.

#### Scenario: Five locales render complete pages

- **WHEN** a visitor opens any plaza page in each of the five locales
- **THEN** every section renders fully in the requested locale, and the locale gate reports key parity across all five

#### Scenario: The mechanism chain explains infrastructure through materials

- **WHEN** a reader follows the supply mechanism section
- **THEN** each of the four segments states what the mechanism does for the materials (e.g. publish freezes an immutable version snapshot) rather than presenting an architecture lecture

#### Scenario: Hero carries the species inventory

- **WHEN** the page loads with a valid catalog
- **THEN** the hero shows the three species counts (agents, skills, MCP services) and the tool count, not only a single pack count

#### Scenario: Species tab filters the gallery

- **WHEN** a visitor selects the skills or MCP species tab
- **THEN** the gallery narrows to that species and the other species' cards are hidden, with counts per tab visible

#### Scenario: Hostname preselects the species

- **WHEN** the site is opened through skills.finddatatech.cloud
- **THEN** the gallery opens preselected on the skills species, while agent.finddatatech.cloud opens unfiltered

### Requirement: Machine surfaces are generated from the registries' own public faces

The plaza's machine surfaces — `llms.txt`, `llms-full.txt`, `catalog.json`, per-material Markdown pages, and `infrastructure.md` — SHALL be generated at build time by the plaza export from the registries' own public faces (the pack listing, the skills catalog, the MCP catalog and its per-server depth). No hand-maintained inventory copy SHALL exist: if a material appears in the machine surfaces, it comes from its registry; if it was unpublished or group-gated away, the next export drops it. `catalog.json` entries SHALL reuse the production annotation shape (`canonical.brief`, `human` in five locales, `whenToUse`, `provenance.source` + `provenance.updatedAt`) with no new vocabulary; MCP entries carry their annotation-layer projection natively, and skill entries not yet covered by an annotation pass SHALL carry their zh source text in all five locale slots with provenance unchanged rather than being silently translated or omitted. Every human page SHALL embed JSON-LD structured data and a link to its machine twin.

#### Scenario: Catalog entries carry the annotation shape

- **WHEN** an AI agent reads `catalog.json`
- **THEN** every entry has a canonical brief, human summaries in five locale slots, a whenToUse hint, and provenance (source and as-of date), using the same field names as the production annotation layer

#### Scenario: MCP entries speak the annotation layer natively

- **WHEN** an annotated MCP server is exported with a requested locale
- **THEN** its catalog entry carries the projected localized name/summary/whenToUse from the supply annotations, falling back to zh exactly as the platform's own surfaces do

#### Scenario: Un-annotated skills are honest about their text

- **WHEN** a skill has no annotation coverage
- **THEN** its entry carries the zh source text (not a machine translation, not an omission) and its provenance still names the skills catalog and as-of date

#### Scenario: Unpublish removes a material from the next export

- **WHEN** a listed pack is unpublished on the market and the export runs again
- **THEN** the material disappears from `catalog.json`, `llms.txt`, and the materials pages, while previously deployed static files keep serving until the next deploy (stale copy visibly older in its provenance date)

#### Scenario: Human pages carry machine twins

- **WHEN** a crawler or AI agent parses any plaza human page
- **THEN** it finds JSON-LD describing the page and a link to the corresponding machine-readable surface

### Requirement: Each species admits through its own registry's public face

The plaza export SHALL admit each species through that species' own source-of-truth public face — packs through the market listing rule (public, non-unlisted, curated — or the operator whitelist replacing curation outright), skills and MCP servers through the registry visibility rule (no required groups = public; group-gated entries never appear anonymously), facades through the deployments public face (only publicly shared facades admit; instance status reported by the serving plane is included when present and rendered as an explicit unknown when absent), and data anchors through the DAAS catalog face (v1 scope: catalog classes; provenance names the DAAS catalog). The export SHALL NOT restate or reinterpret any admission predicate, and SHALL NOT derive a species from another species' badges, names, or category strings. A reconciliation gate SHALL compare the exported catalog's per-species material count with each source's count at export time and fail the build on any mismatch.

#### Scenario: Private, unlisted, and group-gated materials never appear

- **WHEN** the export runs against sources containing private packs, unlisted packs, group-gated MCP servers, and non-public facades
- **THEN** none of them appear in any machine surface or human gallery — byte-identical to what the anonymous browse faces show

#### Scenario: Per-source count reconciliation gate

- **WHEN** any species' exported count differs from its source's count at export time
- **THEN** the export fails naming the species and both counts, and no artifacts are written

#### Scenario: Badge-derived species entries are gone

- **WHEN** a pack carries a facade/assistant badge or a data-ish name but its species' own source has no corresponding record
- **THEN** no facade or data-anchor entry is derived from that pack, and the reconciliation gate counts only source-admitted entries

### Requirement: The inventory spans the three material species

The export SHALL ingest all five material species: packs from the market listing, skills from the skills catalog, MCP servers from the MCP catalog, facades from the deployments public face, and data anchors from the DAAS catalog face. Each MCP server's material page SHALL embed its full public tool surface (tool names and descriptions, tool count, license and provider where exposed) rather than splitting tools into separate pages. Each pack's material page SHALL enumerate the skills and MCP server references declared in its own manifest, so the contents inside 壹座 packs are themselves visible. Each facade's material page SHALL state its deployment provenance and its live status as reported (or an explicit unknown mark). Each data anchor's material page SHALL state its DAAS catalog provenance and as-of date.

#### Scenario: Skills and MCP species are populated

- **WHEN** the export completes with all five sources reachable
- **THEN** `catalog.json` carries nonzero entries for all five species — packs, skills, MCP servers, facades, data anchors — each with a stable species-appropriate address, and the hero counts agree with the catalog

#### Scenario: Facade and data-anchor species are populated by their sources

- **WHEN** the export completes with all five sources reachable
- **THEN** `catalog.json` carries facade and data-anchor entries admitted by their own source faces alongside packs, skills, and MCP servers, each with a stable species-appropriate address

#### Scenario: MCP material page embeds the tool surface

- **WHEN** a reader opens an MCP server's material page
- **THEN** the page lists every public tool with its description and the total tool count, self-contained with provenance

#### Scenario: Pack page enumerates its own contents

- **WHEN** a reader opens a pack's material page
- **THEN** the page names the skills and MCP server references the pack's manifest declares, in addition to the obtain paths

#### Scenario: Facade page is honest about status

- **WHEN** a reader opens a facade's material page whose live status has not been reported
- **THEN** the page renders an explicit unknown status mark rather than a defaulted value

### Requirement: Freshness is always visible and degrade is graceful

The inventory gallery SHALL attempt a live refresh from the market listing API on page load and SHALL silently fall back to the build-time snapshot when the API is unreachable, always labeling which it is showing ("as of <date>" for the snapshot). A page with a valid snapshot SHALL never render an empty inventory because the live fetch failed. The snapshot file SHALL be written at export time and carry its generation date for both the fallback face and audit.

#### Scenario: Live refresh succeeds

- **WHEN** the gallery loads and the market API responds
- **THEN** the inventory reflects the live listing and is not labeled as snapshot

#### Scenario: Live refresh fails to snapshot

- **WHEN** the market API is unreachable from a visitor's browser
- **THEN** the gallery renders the build-time snapshot labeled with its as-of date, and no error blocks the page

### Requirement: AI-readable discipline is gated, not aspirational

The export SHALL enforce six lint rules on every generated machine surface: each section self-contained (no cross-page or cross-section references like "see above"); full entity naming on first mention (壹座·智能体素材广场 / Yizuo Agent Materials Plaza, not "our platform"); one term per concept (素材 never mixed with 资源/内容/资产 in the same meaning); mechanisms expressed as input–action–output tables; every material page independently answerable by a context-free reader to three questions (what is this, how do I obtain it, as of when); and provenance present on every material entry. A lint failure SHALL fail the export build.

#### Scenario: Cold-read three-question assertion

- **WHEN** a material page alone is given to a reader with no other context
- **THEN** the page answers what the material is, how to obtain it (with the copy-ready command or path), and the corpus-as-of date

#### Scenario: Lint failure blocks the build

- **WHEN** a generated page contains a cross-section reference or a missing provenance field
- **THEN** the export exits non-zero naming the offending page and rule, and no artifacts are written

### Requirement: Addresses are stable across content and locale changes

Material page slugs SHALL be stable identifiers that do not change when content updates or locales are added; locale switching SHALL NOT alter material addresses. Slugs SHALL be namespaced per species (pack-, skill-, mcp-) so the three registries never collide. The `catalog.json` category field SHALL be a versioned closed enumeration; adding a new material species SHALL extend the enumeration with a version bump rather than overloading an existing category.

#### Scenario: Content update keeps the address

- **WHEN** a material's corpus is updated and re-exported
- **THEN** its page URL is unchanged, and prior inbound references (from AI agents or other sites) still resolve

#### Scenario: New species extends the enumeration

- **WHEN** a new material species (e.g. fleet templates) joins the plaza
- **THEN** the category enumeration gains a new value with a version bump, and no existing category absorbs it

### Requirement: Three domains open one inventory

The plaza SHALL be reachable through three domains as three doors into one inventory: agent.finddatatech.cloud is the canonical door opening unfiltered; skills.finddatatech.cloud serves the same site with the gallery preselected on the skills species; mcp.finddatatech.cloud's anonymous root path SHALL redirect to the plaza (species-preselected on MCP) while every other path on that domain — the MCP protocol endpoints (/<server>/mcp), the registry console, and its API/registry.json faces — SHALL be untouched, and a request to the mcp. root carrying the registry session SHALL still reach the registry console as its spec governs. All three hostnames SHALL be covered by the edge certificate (single SAN set, all domains listed — a re-sign that drops any prior domain is a failure).

#### Scenario: Skills door preselects the species

- **WHEN** a visitor opens skills.finddatatech.cloud
- **THEN** they see the same plaza inventory with the skills species preselected, and can clear the filter to see everything

#### Scenario: MCP anonymous root redirects, protocol endpoints never

- **WHEN** an anonymous client requests the root of mcp.finddatatech.cloud
- **THEN** it is redirected to the plaza (MCP species preselected), while a request to /<server>/mcp or /api/mcp-registry.json on the same domain is served by the registry unchanged

#### Scenario: Registry session keeps its console

- **WHEN** a client with a valid registry session requests the root of mcp.finddatatech.cloud
- **THEN** the registry console answers as its own product spec requires — the redirect only governs anonymous traffic

#### Scenario: Certificate covers every door

- **WHEN** the edge certificate is re-signed for the plaza's domains
- **THEN** its SAN list includes every prior domain plus the new ones, and a TLS handshake succeeds for all of them
