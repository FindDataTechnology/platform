# role-system Delta

## MODIFIED Requirements

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
