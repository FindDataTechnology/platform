# layout-configuration Specification Delta

## Purpose

布局是数据：统一页面注册表、版本化布局预设、部署默认→业务角色→用户微调的三层解析链（部署隐藏终局），与配套的部署管理面、用户微调面。兑现"不同客户切换整体布局"（ADR-0026）。

## ADDED Requirements

### Requirement: Unified surface registry

The system SHALL maintain a single surface registry covering exactly three containers in v1: primary navigation tabs, Settings sections, and the Agents page sub-tabs. Every surface SHALL be keyed by its existing public route slug (`chat`, `knowledge`, `resources`, `agents`, `apps`, `tasks`, `fleet`; settings section slugs per `settings-surface`; agents sub-tab values per `agent-catalog`). Each registry entry SHALL declare its container, its platform predicates (desktop-only, pack-marketplace-gated, documents-gated, admin-only) and its stable identity metadata (i18n key, icon, testid). Slugs SHALL NOT change and no surface SHALL exist outside the registry.

#### Scenario: registry keys match public routes

- **WHEN** the registry is consumed to render any of the three containers
- **THEN** every rendered surface keeps its existing route slug, testid, and deep-link behavior

#### Scenario: platform predicates are ungated by presets

- **WHEN** a preset lists the `fleet` surface as visible and the client is a browser (not the desktop shell)
- **THEN** the fleet tab does not render, and the same holds for every platform predicate

### Requirement: Versioned layout preset schema

A layout preset SHALL be a versioned object declaring, per container, an ordered list of visible surface slugs (`version` plus `nav`, `settings`, `agentsTabs`). A slug absent from a container's list is hidden by that preset. The schema SHALL carry a version field so later revisions can extend scope (chat-internal panels, interaction modes) without rewriting stored presets. The system SHALL ship two factory presets: `standard-snapshot`, the default, whose per-container lists equal the pre-change hardcoded surfaces exactly (including platform predicates), and `simple`, the non-technical skeleton — navigation limited to Chat, Knowledge, Resources, Agents; Settings limited to the Basics group sections.

#### Scenario: standard-snapshot equals today's surfaces

- **WHEN** no deployment, role, or user layer provides any layout data and `standard-snapshot` resolves
- **THEN** the rendered navigation, Settings sections, and Agents sub-tabs match the pre-change hardcoded behavior exactly, item for item and in order

#### Scenario: simple preset hides technical surfaces

- **WHEN** the `simple` preset resolves for a user
- **THEN** the navigation shows Chat, Knowledge, Resources, Agents only
- **AND** the Settings modal shows only the Basics group sections

### Requirement: Three-layer resolution with terminal deployment hiding

Layout resolution SHALL compose four layers per container: factory preset, deployment default, business-role preset, user adjustment — each layer MAY hide surfaces or reorder the remainder, and MAY NOT reveal a surface hidden by a less specific layer. Resolution SHALL be computed server-side from the user's business roles (per `role-system`), the deployment configuration, and the user's stored adjustments, and delivered as a single resolved layout. Deployment-layer hiding SHALL be terminal: no role preset or user adjustment SHALL re-reveal a deployment-hidden surface. User adjustments SHALL be limited to visibility toggling and reordering of surfaces still visible after the role layer.

#### Scenario: deployment hide is terminal

- **WHEN** the deployment hides `tasks`, the user's role preset lists `tasks`, and the user re-enables it in workbench customization
- **THEN** the resolved layout still omits `tasks`

#### Scenario: role preset narrows within deployment default

- **WHEN** the deployment default is `standard-snapshot` and the user's business role presets `simple`
- **THEN** the resolved layout is `simple`'s narrowing of the deployment default, with user adjustments applied on top

#### Scenario: resolution is delivered server-computed

- **WHEN** an authenticated user reads the boot config endpoint
- **THEN** the response carries the resolved layout for that user, and the client renders from it without recomputing layer precedence

### Requirement: Deployment layout administration

An admin-only Settings section (`layout`, per `settings-surface`) SHALL let the operator choose the deployment default preset, assign a preset per business role, and toggle per-surface deployment hiding, persisted at deployment level (gateway-side store on hosted deployments, the deployment config store locally) and effective without a server restart. Mutation SHALL be admin-gated; non-admin mutation SHALL be rejected with `403` and no stored change. Env seeding SHALL provide the same knobs (default preset, per-role preset map) with stored values winning.

#### Scenario: operator switches deployment default

- **WHEN** an admin sets the deployment default preset to `simple`
- **THEN** users without a role-specific preset or adjustments resolve to `simple` on their next config read, without a server restart

#### Scenario: non-admin cannot mutate deployment layout

- **WHEN** auth is on and a non-admin calls the deployment layout mutation endpoint
- **THEN** the server responds `403` and the stored layout is unchanged

### Requirement: User workbench customization

Each user SHALL get a sidebar entry (工作面定制) opening a customization surface that lists the surfaces visible to them after role-layer resolution and lets them toggle visibility and reorder within that set. Adjustments SHALL persist per user (in the existing per-user preference store), apply to that user only, and never re-reveal a surface hidden by a more specific-to-deployment layer or blocked by a platform predicate. A control SHALL restore the inherited layout (clearing the user's adjustments).

#### Scenario: user hides a tab for themselves

- **WHEN** a user hides the Apps tab in workbench customization
- **THEN** the sidebar omits Apps for that user only, and other users are unaffected

#### Scenario: restore inherited layout

- **WHEN** a user activates the restore control
- **THEN** their stored adjustments are cleared and the resolved layout returns to the role/deployment composition
