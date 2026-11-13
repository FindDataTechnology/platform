# layout-configuration Delta

## MODIFIED Requirements

### Requirement: Three-layer resolution with terminal deployment hiding

Layout resolution SHALL compose four layers per container: factory preset, deployment default, business-role preset, user adjustment — each layer MAY hide surfaces or reorder the remainder, and MAY NOT reveal a surface hidden by a less specific layer. Resolution SHALL be computed server-side from the user's business roles (per `role-system`), the deployment configuration, and the user's stored adjustments, and delivered as a single resolved layout. Deployment-layer hiding SHALL be terminal: no role preset or user adjustment SHALL re-reveal a deployment-hidden surface. User adjustments SHALL be limited to visibility toggling and reordering of surfaces still visible after the role layer.

The business-role layer SHALL NOT apply to administrators (users determined admin per `role-system`'s orthogonal flag): an administrator's resolution composes factory preset, deployment default (with its terminal hiding), and the administrator's own user adjustments only, regardless of any primary or secondary business role they hold. Non-administrators' resolution is unchanged.

#### Scenario: deployment hide is terminal

- **WHEN** the deployment hides `tasks`, the user's role preset lists `tasks`, and the user re-enables it in workbench customization
- **THEN** the resolved layout still omits `tasks`

#### Scenario: role preset narrows within deployment default

- **WHEN** the deployment default is `standard-snapshot` and the user's business role presets `simple`
- **THEN** the resolved layout is `simple`'s narrowing of the deployment default, with user adjustments applied on top

#### Scenario: administrators are exempt from role narrowing

- **WHEN** an administrator holds primary role `stock` (whose preset is `simple`) and the deployment default is `standard-snapshot` with no deployment hiding
- **THEN** the resolved layout equals the deployment default for every container — the administration sections（models, roles, layout, channels, diagnostics, status, branding…）and the full primary navigation are present

#### Scenario: deployment hide stays terminal for administrators

- **WHEN** the deployment hides `fleet` and an administrator holds a business role
- **THEN** the administrator's resolved layout omits `fleet` and otherwise equals the deployment default

#### Scenario: resolution is delivered server-computed

- **WHEN** an authenticated user reads the boot config endpoint
- **THEN** the response carries the resolved layout for that user, and the client renders from it without recomputing layer precedence
