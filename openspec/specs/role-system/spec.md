# role-system Specification

## Purpose

按业务分工划分的用户类型（业务角色）：枚举、部署级存储、admin 分配、主角色制、正交管理员标志与准入组映射。本能力是布局预设与首配方案的共同枢轴（ADR-0028），v1 只管表现层。

## Requirements

### Requirement: Business role enumeration and default

The system SHALL define a fixed enumeration of business roles, each identified by a stable slug: `legal`（法律人员）, `economic`（经济分析）, `financial`（金融分析）, `stock`（股票分析）, `screenplay`（剧本创作）, `paper`（论文写作）, `technical`（技术用户）, and `standard`（标准用户）. Role slugs SHALL NOT change; user-facing labels SHALL resolve from the i18n bundle keyed by the slug. A user with no stored assignment SHALL resolve to `standard` with no secondary roles, and every observable behavior SHALL be identical to the pre-role-system baseline for such a user.

#### Scenario: unassigned user resolves to standard

- **WHEN** a user has no role assignment in storage and the deployment seeds no default
- **THEN** the user resolves to primary role `standard` with no secondary roles
- **AND** no surface the user can see differs from the behavior of a deployment without the role system

#### Scenario: role labels follow locale

- **WHEN** the UI renders a role name and the active locale changes
- **THEN** the displayed label follows the i18n bundle while the role slug stays constant

### Requirement: Primary role with secondary roles

Each user SHALL have exactly one primary business role and zero or more secondary business roles. The primary role is the resolution key for layout preset and default-expert selection in downstream capabilities; secondary roles carry no presentation weight in v1. An assignment change SHALL take effect for the affected user on their next session load without a server restart.

#### Scenario: primary role reassigned by admin

- **WHEN** an admin changes a user's primary role from `legal` to `stock`
- **THEN** the stored assignment reflects primary `stock`
- **AND** the affected user's next session load resolves primary role `stock` without a server restart

#### Scenario: secondary roles accumulate without presentation effect

- **WHEN** a user has primary `legal` and secondary `economic`
- **THEN** presentation-layer resolution in v1 uses `legal` only
- **AND** the secondary role is stored and readable via the role API for downstream resource provisioning

### Requirement: Admin assignment surface and REST

Role assignment SHALL be manageable by admins: a Settings section (per `settings-surface`) listing users with their primary role, secondary roles, and admin flag, plus REST endpoints reading the role enumeration and reading/writing per-user assignments. All mutating endpoints SHALL be admin-gated with the existing admin gate semantics (admin when auth is on; open when auth is off). Non-admin mutation attempts SHALL be rejected with `403` and no stored change.

#### Scenario: non-admin cannot reassign roles

- **WHEN** auth is on and a non-admin user calls a role assignment mutation endpoint
- **THEN** the server responds `403` and no assignment changes

#### Scenario: role enumeration readable by any authenticated user

- **WHEN** an authenticated user reads the role enumeration endpoint
- **THEN** the response lists all role slugs with their localized labels and no assignment data of other users

### Requirement: Administrator as orthogonal flag

The administrator grant SHALL be a flag orthogonal to business roles: any user MAY hold the admin flag alongside any primary/secondary roles. The existing group-based admin determination (`ADMIN_GROUPS` on hosted auth) SHALL remain in effect, and a user determined admin by either the stored flag or the group membership SHALL be treated as admin for every existing admin-gated API. Business role slugs SHALL NOT include an administrator role. An administrator's business roles SHALL remain recorded and continue to drive role-keyed behaviour other than layout (first-run recipes, pack scoping, the assignment surface), but SHALL NOT narrow the administrator's presentation layer (per `layout-configuration`).

#### Scenario: admin flag composes with a business role

- **WHEN** a user holds the admin flag and primary role `legal`
- **THEN** the user is admin for admin-gated APIs
- **AND** the user's presentation-layer resolution is not narrowed by the `legal` role — the administration surfaces stay visible
- **AND** the user's recorded primary role is still `legal` for every non-layout consumer

#### Scenario: group-based admin keeps working unchanged

- **WHEN** auth is on and a user's groups include an `ADMIN_GROUPS` entry but the user has no stored admin flag
- **THEN** the user is admin for admin-gated APIs, as before this change

### Requirement: Admission-group mapping defers to identity groups

Each business role MAY declare mapped admission group names. When a user's identity carries groups, those groups SHALL be the effective admission set for marketplace visibility — role mappings add nothing and remove nothing. When the user's identity carries no groups (local mode, auth off, or hosted users without synced groups), the union of the user's roles' mapped groups SHALL be the effective admission set. Logto-side configuration SHALL require no change.

#### Scenario: role-mapped group satisfies pack visibility without identity groups

- **WHEN** a pack requires group `legal`, the user's identity groups are empty, and the user's primary role `legal` maps to admission group `legal`
- **THEN** the pack is visible and installable for the user

#### Scenario: identity groups remain authoritative when present

- **WHEN** a user's identity groups include `analysts`, none of the user's roles maps `legal`, and the user's primary role is `legal` with a mapped group `legal`
- **THEN** the effective admission set is exactly `analysts` — the role's mapped group adds no admission beyond the identity groups

### Requirement: Deployment-level storage with env seeding

Role assignments SHALL persist at deployment level (visible to the admin regardless of which user cell the admin operates from), seeded by an optional environment variable declaring per-user or default assignments. Stored values SHALL win over env seeding; env seeding SHALL win over the `standard` fallback. The local single-process mode (auth off) SHALL exhibit identical semantics with the local store.

#### Scenario: env-seeded default applies to unassigned users

- **WHEN** the deployment seeds default primary role `legal` and a user has no stored assignment
- **THEN** the user resolves to primary role `legal`

#### Scenario: stored assignment wins over env seed

- **WHEN** a user has stored primary `stock` and the env seeds default `legal`
- **THEN** the user resolves to primary `stock`
