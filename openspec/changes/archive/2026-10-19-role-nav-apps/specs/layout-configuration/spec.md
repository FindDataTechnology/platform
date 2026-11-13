## MODIFIED Requirements

### Requirement: Versioned layout preset schema

A layout preset SHALL be a versioned object declaring, per container, an ordered list of visible surface slugs (`version` plus `nav`, `settings`, `agentsTabs`). A slug absent from a container's list is hidden by that preset. The schema SHALL carry a version field so later revisions can extend scope (chat-internal panels, interaction modes) without rewriting stored presets. The system SHALL ship two factory presets: `standard-snapshot`, the default, whose per-container lists equal the pre-change hardcoded surfaces exactly (including platform predicates), and `simple`, the non-technical skeleton — navigation limited to Chat, Knowledge, Resources, Agents, Apps（the app center is the discovery and connection entry every business user must reach）; Settings limited to the Basics group sections plus Connections. `tasks` and `fleet` SHALL remain outside `simple`.

#### Scenario: standard-snapshot equals today's surfaces

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation, Settings sections, and Agents sub-tabs match the pre-change hardcoded behavior exactly, item for item and in order

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
