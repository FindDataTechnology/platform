# a2a-agent-serving Specification (delta)

## ADDED Requirements

### Requirement: Deploy binds deployer-provided secrets per agent

The deploy action SHALL accept, per serving agent, a map of deployment secrets — arbitrary named values the deployed agent needs at runtime (for example a content-repository token) — minted and delivered by the deployer in the deploy request. Before binding, the platform SHALL validate each secret's name (short lowercase identifier), the per-agent count bound, and each value's size bound; secrets aimed at unknown or non-serving agents SHALL be refused. Bound secrets SHALL be stored under opaque platform-side references, and the deployment descriptor SHALL carry only those references, never the values; the registry entry, marketplace, and every card surface SHALL remain secret-free. Redeployment omitting secrets SHALL keep existing bindings; an explicit null per name SHALL unbind that name; bindings for agents that stop serving SHALL be dropped on redeploy. Logs, audit surfaces, and the deploy surface SHALL show at most a masked reference per secret.

#### Scenario: A deploy binds a deployer-provided secret

- **WHEN** a pack with a serving agent is deployed with a valid secret for that agent — name, count, and size all pass
- **THEN** the secret is stored under a fresh opaque reference, the descriptor carries the reference, and the deploy proceeds

#### Scenario: Secret values never ride public surfaces

- **WHEN** the registry entry, descriptor, marketplace payloads, or AgentCard are inspected
- **THEN** no secret value appears anywhere — only opaque references

#### Scenario: An invalid secret is refused at deploy time

- **WHEN** a pasted secret's name is malformed, the per-agent count is over the bound, a value exceeds the size bound, or it aims at an unknown or non-serving agent
- **THEN** the deploy is refused with a secret-invalid code and the failing reason

#### Scenario: Redeploy keeps, unbinds, and drops per lifecycle

- **WHEN** a pack with bound secrets is redeployed without secrets in the request, with an explicit null for one name, or after an agent stops serving
- **THEN** omitted secrets ride into the new descriptor, the nulled name is unbound, and the stopped agent's bindings are dropped

#### Scenario: Bindings are visible, values are not

- **WHEN** the deployer views a pack's deploy surface after deploying
- **THEN** each serving agent shows which secret names are bound, and no secret value is ever displayed or returned
