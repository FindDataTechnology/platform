## MODIFIED Requirements

### Requirement: Deployment propagates by polling within five minutes

The runner SHALL discover deployed Agent Services by polling the registry, and a deployment SHALL become callable within five minutes of the deploy action completing, without any push dependency and without any manual intervention: within the propagation window the platform SHALL keep re-probing the entry's health until it turns healthy, so the registry's routing surface becomes generatable without a manual toggle. The deploy API response SHALL state the expected effective window, and the marketplace UI SHALL show a two-state status (「部署中」→「在线」) per deployed agent, derived from the registry entry's health.

#### Scenario: Deploy-to-callable latency

- **WHEN** the deploy action completes at time T
- **THEN** the Agent Service answers A2A requests at or before T+5min

#### Scenario: Status reflects health

- **WHEN** a deployed agent's registry health check turns unhealthy
- **THEN** the marketplace UI shows the agent as not 在线

#### Scenario: Fresh deployment needs no manual re-toggle

- **WHEN** a newly deployed agent's first health probe fails because the runner has not yet picked the entry up
- **THEN** the platform re-probes automatically within the propagation window, and the entry reaches healthy — and facade calls stop failing with -32033 — with no operator action
