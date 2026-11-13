# a2a-agent-serving delta

## ADDED Requirements

### Requirement: Deployments are assigned to a fleet runner

The deploy surface SHALL keep a runner fleet registry (id, base URL, per-agent port base and span) seeded at boot from the legacy single-runner environment so the default deployment target and its computed serving URLs are byte-identical to the pre-fleet era. A deploy request SHALL accept an optional runner id, resolve it against the fleet registry, stamp the deployment descriptor with it, and compute the registered serving URL from that runner's base URL and port span. Deployments SHALL remain addressable regardless of assignment: the registry routes to whichever runner's URL the entry carries, and cross-runner agent-to-agent calls need no new path.

#### Scenario: The default deploy is byte-identical to the legacy era

- **WHEN** an operator deploys without naming a runner and the fleet table holds the seeded legacy row
- **THEN** the entry's serving URL and untagged assignment match exactly what the single-runner env produced

#### Scenario: A deploy assigned to a second runner lands on it

- **WHEN** a deploy names runner-b
- **THEN** the registry entry carries runner-b's URL and a `runner_id` tag, and runner-b alone hosts it

#### Scenario: The fleet list is readable over the internal face

- **WHEN** a service-credentialed caller requests the runners list
- **THEN** it receives the fleet rows (id, base URL, port geometry) for placement surfaces
