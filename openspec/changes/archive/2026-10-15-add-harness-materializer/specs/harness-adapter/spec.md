## ADDED Requirements

### Requirement: Pack content materializes into the target harness's native layout

The runner's composition SHALL be harness-aware: a deployment's pack content — persona, skills,
MCP references, and data-workspace declaration — SHALL be materialized into the layout the
declared harness natively reads. For the default dsh harness this SHALL be the existing
private-home pipeline, unchanged; for an ACP harness this SHALL be a private per-agent
workspace carrying the persona as the harness's native project-instructions file, one
harness-native skill entry per pack skill, the MCP references on the harness's
session-creation channel as authorized streamable-http servers, and the data workspace
exposed through the process environment. Composition SHALL NOT materialize artifacts the
target harness cannot read (no dsh home for a non-dsh spawn). Pack parts with no honest
equivalent on the target harness SHALL fail closed with a structured error naming them
(deployment secrets) or degrade with a recorded warning (tool allowlists) — never silently
drop. Deployer billing SHALL be preserved across harnesses: a deployment pinning a billing
key reference authenticates its harness process with the deployer's key, uniform with the
dsh path's attribution semantics. A hosted harness name without a layout mapping SHALL serve
bare — workspace, environment, model — with the unmapped content parts named in a warning.

#### Scenario: An ACP deployment's pack content lands in the harness-native workspace

- **WHEN** an ACP-harness deployment with a persona, two skills, one MCP reference, and a
  data-workspace declaration is composed
- **THEN** its private workspace carries the persona as the harness's project-instructions
  file, one harness-native skill entry per skill, the MCP reference rides the
  session-creation channel as a streamable-http server bearing the caller's authorization,
  and the data workspace reaches the process as environment markers

#### Scenario: The dsh composition pipeline is unchanged

- **WHEN** a deployment on the default dsh harness is composed and spawned
- **THEN** it materializes exactly the private dsh home the runner produced before
  harness-aware composition — no harness-native workspace files appear in a dsh home, and
  no dsh home is built for a non-dsh spawn

#### Scenario: Deployment secrets are refused, not silently dropped

- **WHEN** an ACP-harness deployment declares deployment secrets and composition runs
- **THEN** composition fails with a structured error naming the secrets and the harness's
  lack of a controlled channel for them — the agent never starts half-credentialed, and the
  failure distinguishes itself from a fetch failure

#### Scenario: An unmapped harness serves bare with the gap named

- **WHEN** a hosted harness name has no layout mapping and its deployment declares pack
  content beyond the bare spawn inputs
- **THEN** the deployment still serves with its workspace, environment, and model, and a
  recorded warning names every content part that found no native mapping

#### Scenario: The deployer's billing key applies on the non-default harness

- **WHEN** an ACP-harness deployment pins a billing key reference while its runner holds a
  standing harness credential
- **THEN** the spawned harness process authenticates with the deployer's key, so its turns
  bill the deployer with the same attribution semantics as the dsh path
