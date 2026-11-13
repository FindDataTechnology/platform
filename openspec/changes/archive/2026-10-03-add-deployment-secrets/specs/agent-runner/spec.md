# agent-runner Specification (delta)

## ADDED Requirements

### Requirement: The runner fetches agent secrets over an authenticated channel and pins them into the child

The platform SHALL serve each deployment secret's value to the runner through a gateway route authenticated by the runner's service credential, keyed by the descriptor's secret reference; every fetch SHALL be audit-logged with the reference and agent, never the value. At child composition the runner SHALL pin every declared secret into that agent's private credentials file — the only channel that reaches the child, whose environment is scrubbed — under the secret's declared name. A declared secret whose value cannot be fetched SHALL fail that agent's composition loudly with the missing reference named; the runner SHALL NOT compose the child with a silently partial secret set, and SHALL NOT substitute any fallback value.

#### Scenario: The child receives its declared secrets

- **WHEN** a deployed agent whose descriptor declares two secret references composes
- **THEN** both values land in the child's private credentials file under their declared names, fetched by reference over the service-credential route

#### Scenario: A missing secret fails composition loudly

- **WHEN** a descriptor declares a secret reference the fetch cannot resolve
- **THEN** that agent's child fails to compose with the missing reference named, no partial secret set is installed, and no fallback value is substituted

#### Scenario: Every fetch is audited without the value

- **WHEN** the runner fetches a secret by reference
- **THEN** an audit record names the reference and the agent, and contains no secret material
