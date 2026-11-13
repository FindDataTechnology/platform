# agent-runner 变更 Delta

## MODIFIED Requirements

### Requirement: One dedicated runtime child per deployed role

The runner SHALL host each deployed Agent Service as a dedicated runtime child with its own private runtime home, composed from the deployment descriptor: the role's persona, its declared skills (fetched from the registry's skill entries), and its declared MCP references. The child's inference model SHALL be the descriptor's effective model when it records one, else the runner's deployment-level default model (ADR-0019); and its inference SHALL consume the runner's service quota — never a user's. A change of the descriptor's effective model SHALL take effect by the upgrade-grade drain-and-respawn: in-flight turns drain, the child respawns on the new model within the five-minute window, and no other restart channel is introduced. The child's MCP outbound calls SHALL authenticate with the runner's service credential.

#### Scenario: Composition from the descriptor

- **WHEN** the runner materializes a deployed role whose descriptor declares a persona, two skills, and one MCP reference
- **THEN** the child boots with that persona and exactly those skills and MCP servers available

#### Scenario: Model is a runner concern

- **WHEN** a deployed role serves a turn
- **THEN** the turn runs on the descriptor's effective model, or the runner's deployment default when the descriptor records none — regardless of any cell's model selection

#### Scenario: A model change drains and respawns

- **WHEN** the descriptor's effective model changes
- **THEN** in-flight turns drain (new turns during drain get the explicit drain error, not a hang), the child respawns on the new model, and the change is live within the five-minute window
