# agent-delegation-a2a Delta

## MODIFIED Requirements

### Requirement: Delegated calls carry the deployment's gateway credential

Outbound a2a task calls SHALL ride the cell owner's PERSONAL registry credential (this requirement supersedes the shared-deployment-credential form; same requirement, C-lite settlement) (the per-user market credential the connect flow already stores) as the gateway credential (`X-Authorization`) — the platform ensures the owner's registry account carries the invoke-only caller group, so the personal credential passes the invoke gate with per-user attribution (ADR-0013's C-lite settlement). Deployments without an owner credential (single-owner local machines) SHALL use the deployment's registry service credential and SAY SO in the turn's error surface; the credential's absence on a hosted cell SHALL fail those calls with a structured connect-guidance error, never a silent substitution.

#### Scenario: The owner's credential carries the delegation

- **WHEN** a delegated a2a task call leaves a hosted cell whose owner connected the market
- **THEN** its X-Authorization carries the owner's personal registry credential, and the invoke gate attributes the call to that user

#### Scenario: An unconnected owner is guided to connect

- **WHEN** a delegation is attempted on a hosted cell whose owner has no stored registry credential
- **THEN** the task fails with a structured error directing the user to connect the MCP market, and no other token is used in its place

#### Scenario: The invoke-only scope maps to real identities

- **WHEN** the registry's scopes are inspected after this change
- **THEN** the paas-agent-callers scope carries only the invoke_agent action and is assigned to connecting platform users by the platform's connect flow

#### Scenario: Delegation rides the service credential

- **WHEN** a delegated a2a task call leaves a deployment running under the explicit service-credential fallback
- **THEN** its X-Authorization carries the deployment's registry service credential, stated as such in the deploy surface's configuration notes

#### Scenario: Missing credential fails loudly

- **WHEN** a delegation to a market agent is attempted while no usable credential exists (no owner credential, no service credential)
- **THEN** the task fails with a structured error naming the missing credential, and no other token is used in its place

#### Scenario: The invoke-only scope stays dormant

- **WHEN** no platform user has connected the market in a deployment
- **THEN** the paas-agent-callers scope exists with only the invoke_agent action and maps to no identity until a user connects
