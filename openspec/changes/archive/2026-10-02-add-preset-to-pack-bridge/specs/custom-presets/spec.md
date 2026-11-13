# custom-presets Delta

## MODIFIED Requirements

### Requirement: Custom presets stay cell-local

A custom preset SHALL NOT be publishable to the marketplace and SHALL NOT appear in any marketplace surface; it exists only in its cell's roster. Sharing a composition SHALL go through authoring a pack draft in the marketplace's creator path, never through a local preset gaining a publish action. The preset management surface SHALL offer exactly one export-shaped affordance: a one-way conversion action that pre-fills a new pack draft in the author's own cell (openspec: pack-authoring); the conversion SHALL NOT publish anything, SHALL NOT modify the preset, and SHALL NOT create any lasting link between the preset and the draft.

#### Scenario: No publish path exists

- **WHEN** a user wants to share a custom preset's composition with another cell
- **THEN** the only path is authoring a pack draft — by hand in the creator editor or through the one-way conversion action; the custom-preset surface offers no publish or share affordance

#### Scenario: One-way bridge into authoring

- **WHEN** a user invokes the conversion action on a custom preset
- **THEN** a new pack draft is created in the author's cell, pre-filled per the pack-authoring conversion requirement, while the preset itself is untouched and remains cell-local

#### Scenario: Conversion never publishes

- **WHEN** the conversion action completes
- **THEN** nothing has been published to the marketplace and no pack version exists — only a private draft in the author's cell
