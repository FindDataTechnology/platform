## MODIFIED Requirements

### Requirement: Versioned layout preset schema

A layout preset SHALL be a versioned object declaring, per container, an ordered list of visible surface slugs (`version` plus `nav`, `settings`, `agentsTabs`). A slug absent from a container's list is hidden by that preset. The schema SHALL carry a version field so later revisions can extend scope (chat-internal panels, interaction modes) without rewriting stored presets. The system SHALL ship two factory presets: `standard-snapshot`, the default, whose per-container lists equal the pre-simplify-chat-and-agents-ia hardcoded surfaces exactly (including platform predicates) **except** that `agentsTabs` lists `agents` and `market` only — the `apps` sub-tab is retired from every factory preset (its entries live in the app center, openspec: app-center) while its slug remains in the registry so stored presets and deep links keep resolving — **and** whose `nav` list omits `blueprints`: the blueprint studio's nav entry is retired into the workspace redirect, while its registry slug remains so stored presets and deep links keep resolving; and `simple`, the non-technical skeleton — navigation limited to Chat, Knowledge, Resources, Agents, Apps（the app center is the discovery and connection entry every business user must reach）; Settings limited to the Basics group sections plus Connections. `tasks` and `fleet` SHALL remain outside `simple`.

#### Scenario: standard-snapshot equals today's surfaces

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation and Settings sections match the pre-change hardcoded behavior exactly, item for item and in order, **except** that the navigation omits the 蓝图构造间 entry (retired to the workspace redirect)
- **AND** the Agents page renders exactly the Experts and Packs sub-tabs, in that order, with no Apps sub-tab

#### Scenario: simple preset hides technical surfaces

- **WHEN** the `simple` preset resolves for a user
- **THEN** the navigation shows Chat, Knowledge, Resources, Agents, Apps only, in registry order
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
