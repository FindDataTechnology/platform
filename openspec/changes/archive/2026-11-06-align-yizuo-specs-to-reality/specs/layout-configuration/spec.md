## MODIFIED Requirements

### Requirement: Unified surface registry

The system SHALL maintain a single surface registry covering exactly three containers in v1: primary navigation tabs, Settings sections, and the Agents page sub-tabs. Every surface SHALL be keyed by its existing public route slug (`chat`, `knowledge`, `resources`, `memory`, `agents`, `apps`, `tasks`, `fleets`, `machines`, `zhiyu`, `blueprints`, `fleet`; settings section slugs per `settings-surface`; agents sub-tab values per `agent-catalog`). Each registry entry SHALL declare its container, its platform predicates (desktop-only, pack-marketplace-gated, documents-gated, admin-only) and its stable identity metadata (i18n key, icon, testid). Slugs SHALL NOT change and no surface SHALL exist outside the registry.

#### Scenario: registry keys match public routes

- **WHEN** the registry is consumed to render any of the three containers
- **THEN** every rendered surface keeps its existing route slug, testid, and deep-link behavior

#### Scenario: platform predicates are ungated by presets

- **WHEN** a preset lists the `fleet` surface as visible and the client is a browser (not the desktop shell)
- **THEN** the fleet tab does not render, and the same holds for every platform predicate

### Requirement: Versioned layout preset schema

A layout preset SHALL be a versioned object declaring, per container, an ordered list of visible surface slugs (`version` plus `nav`, `settings`, `agentsTabs`). A slug absent from a container's list is hidden by that preset. The schema SHALL carry a version field so later revisions can extend scope (chat-internal panels, interaction modes) without rewriting stored presets. The system SHALL ship two factory presets: `standard-snapshot`, the default, whose `nav` list equals the unified surface registry's nav order exactly (including platform predicates) **minus** `blueprints` — the blueprint studio's nav entry is retired into the workspace redirect, while its registry slug remains so stored presets and deep links keep resolving; the registry carries the post-simplify web surfaces `memory`, `fleets`, `machines`, and `zhiyu` alongside the pre-simplify set, and `standard-snapshot` renders them all in registry order — **and** whose `agentsTabs` lists `agents` and `market` only — the `apps` sub-tab is retired from every factory preset (its entries live in the app center, openspec: app-center) while its slug remains in the registry so stored presets and deep links keep resolving; and `simple`, the non-technical skeleton — navigation limited to Chat, Knowledge, Resources, Memory, Agents, Apps（the app center is the discovery and connection entry every business user must reach）; Settings limited to the Basics group sections plus Connections. `tasks` and `fleet` SHALL remain outside `simple`.

#### Scenario: standard-snapshot equals today's surfaces

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation and Settings sections match the unified surface registry item for item and in order, **except** that the navigation omits the 蓝图构造间 entry (retired to the workspace redirect)
- **AND** the Agents page renders exactly the Experts and Packs sub-tabs, in that order, with no Apps sub-tab

#### Scenario: simple preset hides technical surfaces

- **WHEN** the `simple` preset resolves for a user
- **THEN** the navigation shows Chat, Knowledge, Resources, Memory, Agents, Apps only, in registry order
- **AND** the Settings modal shows only the Basics group sections plus Connections

#### Scenario: business-role users reach the app center

- **WHEN** a non-administrator whose primary role resolves to the `simple` preset（e.g. `stock`）opens the workbench with no deployment-layer hiding of `apps`
- **THEN** the primary navigation carries the Apps entry and it opens the app center

#### Scenario: deployment hiding of apps stays terminal

- **WHEN** the deployment hides `apps` and the user's role preset is `simple`
- **THEN** the resolved navigation omits Apps（the role layer cannot reveal a deployment-hidden surface）

#### Scenario: stored layouts referencing the apps sub-tab degrade safely

- **WHEN** a stored preset or user adjustment lists `apps` in `agentsTabs`
- **THEN** resolution SHALL keep the registry slug valid while the tab does not render, and a `?tab=apps` deep link falls back to the first visible tab without error

#### Scenario: stored layouts naming blueprints keep resolving

- **WHEN** a stored preset or user adjustment lists `blueprints` in `nav` after the factory preset dropped it
- **THEN** validation accepts the slug (it remains in the registry) and the item renders for that user; a fresh resolution without stored layers shows no such entry
