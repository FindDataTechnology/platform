# external-skill-sources Delta

## MODIFIED Requirements

### Requirement: Shelf visibility without a feature flag

The external shelf SHALL render by default as the **外部市场** zone inside the Market tab of the extensions surface, visible in the skills sub-view (per `extension-management-ui`). There SHALL be no separate feature flag gating its presence; operators who need it gone disable the sources via `EXTERNAL_SKILL_SOURCES` (which empties the shelf) or roll back the deployment.

#### Scenario: default visibility

- **WHEN** a user opens the Market tab in the skills sub-view of the extensions surface
- **THEN** the external-market zone is present without any server-side flag being set

#### Scenario: absent from the tools sub-view

- **WHEN** a user opens the Market tab in the tools (mcp) sub-view
- **THEN** no external-market zone is rendered there
