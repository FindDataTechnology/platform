## ADDED Requirements

### Requirement: Client capabilities are stated as a verified matrix

The facet surface SHALL publish a client-capability matrix — per client: user-level and project-level skill installation, user-level and project-level MCP config writing, marketplace form availability, and the update path — with each cell traceable to either a code fact (what the CLI writes) or a recorded real-environment walkthrough (what the client honors), never invention. The matrix SHALL render in the docs view (derived from the same single-source facts as the command tables, so drift fails tests) and ship in the OSS deep docs. A smoke script SHALL verify the CLI side periodically: isolated-home installs per target with the native config shapes asserted per client, runnable in CI without real credentials.

#### Scenario: The docs view answers "can it" at a glance

- **WHEN** a visitor opens the docs view's install section
- **THEN** the capability matrix renders one row per client with its verified cells, and the deep guides carry the per-client evidence

#### Scenario: The smoke catches a shape drift

- **WHEN** the CLI's write path for any target changes shape (file location or entry form)
- **THEN** the smoke script's assertion for that target fails, forcing the matrix and guides to move with the code
