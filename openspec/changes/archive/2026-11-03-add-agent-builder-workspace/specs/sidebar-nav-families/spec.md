## MODIFIED Requirements

### Requirement: Nav entries render inside collapsible families

The sidebar's upper tab region SHALL render registry-resolved nav entries grouped into labeled families, each with a collapse/expand control. The "知识" family SHALL contain the knowledge, resources, and memory surfaces; the "构建" family SHALL contain the agent-builder (agents) and agent-teams (fleets) surfaces — the author→run pair that creates teams and runs them; the blueprint-studio (blueprints) surface SHALL NOT be a family member (its nav entry is retired; the route remains a redirect into the workspace). Remaining surfaces render under their own entries as today. Family membership is presentation metadata layered on the surface registry: preset narrowing and predicates (adminOnly, desktopOnly) apply before grouping, and a slug the resolver hides SHALL never appear inside a family.

#### Scenario: family renders its members

- **WHEN** the resolver includes knowledge, resources, and memory
- **THEN** the 知识 family renders containing all three entries

#### Scenario: the compose pair sits together

- **WHEN** the resolver includes both agents and fleets
- **THEN** both render inside the 构建 family, adjacent in registry order, and blueprints renders in no family

#### Scenario: preset-hidden member drops out of its family

- **WHEN** the active layout preset excludes memory
- **THEN** the 知识 family renders with the remaining members and no disabled placeholder for memory
