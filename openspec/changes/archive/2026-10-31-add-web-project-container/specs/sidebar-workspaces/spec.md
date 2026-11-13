# sidebar-workspaces Specification (delta)

## MODIFIED Requirements

### Requirement: Sessions group under the workspace they ran in
The session list SHALL render collapsible groups, with the grouping key forked by surface. On the web surface the key SHALL be the session's project attribution (openspec: project-container): sessions stamped with a project id group under the project's display name, and sessions without one group under the read-time 默认项目 fallback; the group header SHALL show the project name, never the absolute path (the path remains visible as a per-project detail, e.g. tooltip or project view). On the desktop surface the key SHALL remain the workspace path recorded on each session, with an "Ungrouped" fallback for unstamped rows, exactly as before. On both surfaces group membership is fixed at the session's first mirrored turn and SHALL NOT follow later workspace or project switches.

#### Scenario: sessions split across two workspaces
- **WHEN** the sessions payload contains sessions stamped with workspace A and workspace B and neither carries a project attribution (the desktop surface, or web rows predating attribution)
- **THEN** each session appears only under its stamped workspace group (desktop) or the 默认项目 fallback (web), and no session appears twice

#### Scenario: sessions split across two projects on web
- **WHEN** the web surface lists sessions attributed to project A and project B
- **THEN** the sidebar renders two groups titled by the projects' display names, and each session appears only under its attributed project

#### Scenario: absolute paths do not front the web sidebar
- **WHEN** any web group renders
- **THEN** the group label shows the project name (or 默认项目), not a filesystem path

#### Scenario: desktop grouping is unchanged
- **WHEN** the desktop surface lists the same sessions payload
- **THEN** groups are keyed by workspace path with the Ungrouped fallback, as prior to this change

#### Scenario: workspace switch does not re-group the live session
- **WHEN** the user switches the runtime workspace mid-conversation and then sends a turn
- **THEN** the session remains listed under the group it started in

#### Scenario: legacy session without a workspace
- **WHEN** a session row has no recorded workspace and no project attribution
- **THEN** on web it renders under the 默认项目 group; on desktop under Ungrouped
