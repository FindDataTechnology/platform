# sidebar-nav-families Specification

## Purpose

Gives the left navigation a family grouping with collapse/expand (Codex-style) so the ever-growing list of nav surfaces stays scannable, while the surface registry remains the single authority over which entries exist at all.

## ADDED Requirements

### Requirement: Nav entries render inside collapsible families
The sidebar's upper tab region SHALL render registry-resolved nav entries grouped into labeled families, each with a collapse/expand control. The "知识" family SHALL contain the knowledge, resources, and memory surfaces; the "构建" family SHALL contain the agent-teams (fleets) and blueprint-studio (blueprints) surfaces — the compose→materialize pair that authors and runs teams; remaining surfaces render under their own entries as today. Family membership is presentation metadata layered on the surface registry: preset narrowing and predicates (adminOnly, desktopOnly) apply before grouping, and a slug the resolver hides SHALL never appear inside a family.

#### Scenario: family renders its members
- **WHEN** the resolver includes knowledge, resources, and memory
- **THEN** the 知识 family renders containing all three entries

#### Scenario: the compose pair sits together
- **WHEN** the resolver includes both fleets and blueprints
- **THEN** both render inside the 构建 family, adjacent in registry order

#### Scenario: preset-hidden member drops out of its family
- **WHEN** the active layout preset excludes memory
- **THEN** the 知识 family renders with the remaining members and no disabled placeholder for memory

### Requirement: The active surface is always visible
The family containing the current route SHALL render expanded, and its active entry highlighted, regardless of stored collapse state. Activating an entry inside a collapsed family (via deep link or programmatic navigation) SHALL auto-expand that family.

#### Scenario: reload into a collapsed family's route
- **WHEN** the 知识 family is collapsed and the user opens /knowledge directly
- **THEN** the family renders expanded with knowledge marked active

### Requirement: Collapse state persists per user
Collapsing or expanding a family SHALL persist across sessions and restarts for that user's default; a freshly seeded family defaults to expanded.

#### Scenario: state survives a reload
- **WHEN** the user collapses 知识, reloads the page, and the family contains no active route
- **THEN** the family renders collapsed

### Requirement: Families never alter routing
Grouping SHALL NOT change any surface's route: deep links to existing paths land on the same pages as before, with no family segment in the URL.

#### Scenario: existing deep link unaffected
- **WHEN** a user follows a pre-grouping link to /resources
- **THEN** the resources page opens, and the 知识 family (if collapsed) expands to show it
