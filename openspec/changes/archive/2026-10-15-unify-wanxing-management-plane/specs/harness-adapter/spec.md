## MODIFIED Requirements

### Requirement: Harness selection is declared per deployment and gated at deploy time

A deployment descriptor MAY declare its harness (`harness` field; absent = the runner's default
harness). A pack's serving contract SHALL be able to declare that harness as a bounded NAME
(the runner-side allowlist resolves a name, never a command), and the manifest validator SHALL
admit that declaration — a gate that reads a field the publish path refuses is a broken seam.
The runner SHALL report the harnesses it can host in its heartbeat, and the deploy gate SHALL
refuse — naming the missing harness and the target runner — a deployment whose declared harness
is not in the target runner's reported set; unknown or absent self-report SHALL degrade open,
exactly like the model-roster gate. The heartbeat SHALL also carry the runner's pod co-hosting
mode (density) so fleet views can tell solo runners from pod runners; an absent density field
SHALL degrade open (read as a solo runner). Routing a deployment to a runner SHALL use the existing
runner assignment channel; no second placement mechanism SHALL be introduced.

#### Scenario: A harness-mismatched deployment is refused at deploy time

- **WHEN** a descriptor declares `harness: acp-claude-code` and the target runner reports only dsh
- **THEN** the deploy is refused with an error naming the harness and the runner

#### Scenario: A declared harness publishes and reaches the deploy gate

- **WHEN** a pack's serving contract declares `harness: acp-claude-code` and the pack is published
- **THEN** the manifest validates (the declaration is a legal serving key) and a deploy of the
  published version to a runner reporting only dsh is refused with the mismatch error

#### Scenario: The heartbeat reports hostable harnesses

- **WHEN** a runner with both dsh and ACP adapters heartbeats
- **THEN** its runner_stats row carries the harness set the deploy gate reads

#### Scenario: The heartbeat reports the runner's density mode

- **WHEN** a runner configured for pod co-hosting heartbeats
- **THEN** its runner_stats row carries a truthy pod density field, and a solo runner carries a
  falsy one

#### Scenario: Unknown harness metadata degrades open

- **WHEN** the target runner's heartbeat carries no harness field (older runner)
- **THEN** the deploy proceeds under the legacy behavior
