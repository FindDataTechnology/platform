## MODIFIED Requirements

### Requirement: Machine surfaces are generated from the registries' own public faces

The plaza's machine surfaces — `llms.txt`, `llms-full.txt`, `catalog.json`, per-material Markdown pages, and `infrastructure.md` — SHALL be generated at build time by the plaza export from the registries' own public faces (the pack listing, the skills catalog, the MCP catalog and its per-server depth). No hand-maintained inventory copy SHALL exist: if a material appears in the machine surfaces, it comes from its registry; if it was unpublished or group-gated away, the next export drops it. `catalog.json` entries SHALL reuse the production annotation shape (`canonical.brief`, `human` in five locales, `whenToUse`, `provenance.source` + `provenance.updatedAt`) with no new vocabulary; MCP entries carry their annotation-layer projection natively, and skill entries not yet covered by an annotation pass SHALL carry their zh source text in all five locale slots with provenance unchanged rather than being silently translated or omitted. Every human page SHALL embed JSON-LD structured data and a link to its machine twin.

The plaza host SHALL serve the machine surfaces at their canonical root paths — `/llms.txt`, `/llms-full.txt`, `/catalog.json`, `/robots.txt` — and the deployment SHALL verify those four paths return their own file content after every deploy. A machine path SHALL NOT be answered with the human shell or any other HTML document: a host that does not own a machine surface SHALL answer 404 for it rather than a soft success.

Every material count printed on a machine surface SHALL be derived from the supply species enumeration and SHALL name its species explicitly. A composite label that folds several species into one number (for example an "agents" total spanning packs, facades and data anchors) SHALL NOT appear on a machine surface.

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

#### Scenario: Root machine paths serve their own file

- **WHEN** an agent requests `/llms.txt`, `/llms-full.txt`, `/catalog.json` or `/robots.txt` on the plaza host
- **THEN** the response body is that surface's own content with a matching content type, never an HTML document

#### Scenario: A host without machine faces answers 404

- **WHEN** a machine path is requested on a host that owns no machine surface (the facet shell host)
- **THEN** the response is 404, not a soft success carrying the human shell

#### Scenario: Counts name their species

- **WHEN** any machine surface prints inventory counts
- **THEN** each count is labeled with a species name from the supply species enumeration, and no merged multi-species total appears

### Requirement: Freshness is always visible and degrade is graceful

The inventory gallery SHALL attempt a live refresh from the market listing API on page load and SHALL silently fall back to the build-time snapshot when the API is unreachable, always labeling which it is showing ("as of <date>" for the snapshot). A page with a valid snapshot SHALL never render an empty inventory because the live fetch failed. The snapshot file SHALL be written at export time and carry its generation date for both the fallback face and audit.

The export SHALL additionally run on a bounded cadence independent of human deploys, so the machine surfaces cannot drift indefinitely behind the live market. Each machine surface SHALL carry its generation timestamp, and the export SHALL fail rather than publish a surface whose per-species counts disagree with the source registries at export time.

#### Scenario: Live refresh succeeds

- **WHEN** the gallery loads and the market API responds
- **THEN** the inventory reflects the live listing and is not labeled as snapshot

#### Scenario: Live refresh fails to snapshot

- **WHEN** the market API is unreachable from a visitor's browser
- **THEN** the gallery renders the build-time snapshot labeled with its as-of date, and no error blocks the page

#### Scenario: Machine surfaces refresh without a deploy

- **WHEN** the market gains a pack and no human deploys the plaza
- **THEN** the scheduled export regenerates the machine surfaces and their generation timestamps advance

#### Scenario: Stale export cannot publish

- **WHEN** the export's per-species counts disagree with a source registry at export time
- **THEN** the export fails and the previously published surfaces keep serving with their older timestamp
