# external-skill-sources Specification (delta)

## Purpose
外部技能市场的只读接入面：把外部市场（腾讯 SkillHub、Smithery）的技能元数据镜像进壹座扩展市场的一个独立货架，让用户能发现外面有什么；条目全程携带来源与审校状态标记，且不提供任何安装路径——内容进入运行时属于后续 change。

## ADDED Requirements

### Requirement: Source adapters are registry-driven and env-gated

The platform SHALL implement external skill sources through a source-adapter contract (list and fetch operations per source) and a source registry. The set of enabled sources SHALL be controlled by the `EXTERNAL_SKILL_SOURCES` environment variable (comma-separated source ids; unset or empty = all known sources enabled; unknown ids ignored). The read-only external shelf SHALL list exactly the enabled sources, and a disabled or failing source SHALL NOT affect other sources' availability.

#### Scenario: default enables both sources

- **WHEN** the server starts without `EXTERNAL_SKILL_SOURCES` set
- **THEN** the skillhub and smithery sources are enabled and the shelf lists entries from both

#### Scenario: operator disables one source

- **WHEN** `EXTERNAL_SKILL_SOURCES=skillhub` is set
- **THEN** only skillhub entries appear in the shelf and smithery is never fetched

#### Scenario: one failing source does not break the shelf

- **WHEN** smithery's upstream is unreachable at search time
- **THEN** skillhub results still return normally, and smithery's section renders its stale/error state

### Requirement: Aggregated search returns grouped results with per-source admission

The server SHALL expose an aggregated search endpoint that queries every enabled source's search API server-side, takes the top N results per source (default 20), and returns them grouped by source. The endpoint SHALL NOT promise exhaustive pagination; deep paging is out of scope for this capability. No external search request SHALL be issued from the browser — the aggregation happens server-side only.

#### Scenario: one query fans out to all enabled sources

- **WHEN** the client requests a search for "pdf"
- **THEN** the response contains a skillhub group and a smithery group, each with up to 20 entries, each entry carrying its source id

#### Scenario: browser never talks to external APIs

- **WHEN** any shelf interaction occurs (search, category browse, detail view)
- **THEN** all external HTTP requests originate from the server, and the browser only calls the platform's own endpoints

### Requirement: Entries carry provenance and curation-status marks

Every external-shelf entry SHALL carry: its source market name, the upstream origin (source URL — repository or market page), and a license state of exactly declared (license text present) / not-declared (upstream declares no license) / unknown (license existence cannot be determined from the metadata). Every entry SHALL additionally render an explicit "not reviewed by this platform" mark. Absent provenance SHALL render an explicit not-declared mark, never a blank area and never an invented value.

#### Scenario: entry with license renders three marks

- **WHEN** a shelf entry's upstream metadata declares a license
- **THEN** the card shows the source market, the upstream origin URL, the license text under the declared state, and the not-reviewed mark

#### Scenario: licenseless upstream renders honestly

- **WHEN** a shelf entry's upstream metadata carries no license information
- **THEN** the license field renders the explicit not-declared state, never an empty space

### Requirement: External shelf is read-only

The external shelf SHALL NOT provide any install, import, or add-to-pack path. External entry metadata SHALL NOT be written into the skill store, pack manifests, or the materialization tree. The shelf's only mutations are the server-side snapshot cache refreshes described below.

#### Scenario: no install affordance exists

- **WHEN** a user views any external shelf entry or its detail view
- **THEN** no install/import button or API path is offered, and no platform database row or runtime file records the entry

### Requirement: Server-side snapshots with stale-on-failure posture

The server SHALL cache each source's fetched data with a TTL of at most 1 hour and serve reads from the snapshot within that window. When a source's refresh fails or returns an unusable response, the server SHALL keep serving the previous good snapshot and mark that source stale (with the snapshot's age), never emptying the group on a bad response.

#### Scenario: TTL-bounded revalidation

- **WHEN** two searches occur within one hour
- **THEN** the second search is served from the cached snapshot without hitting the external API

#### Scenario: bad response keeps the last good snapshot

- **WHEN** a source's refresh throws or returns malformed data after a previously successful fetch
- **THEN** the shelf continues to show the prior entries flagged stale with the snapshot age, instead of showing nothing

### Requirement: Shelf visibility without a feature flag

The external shelf tab SHALL be visible by default in the extensions market surface. There SHALL be no separate feature flag gating its presence; operators who need it gone disable the sources via `EXTERNAL_SKILL_SOURCES` (which empties the shelf) or roll back the deployment.

#### Scenario: default visibility

- **WHEN** a user opens the extensions market surface
- **THEN** the external-source tab is present alongside the existing MCP and skills tabs without any server-side flag being set
