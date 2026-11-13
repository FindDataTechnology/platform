# pack-marketplace Delta

## MODIFIED Requirements

### Requirement: Publish abuse controls

The publish endpoint SHALL apply per-author rate limiting and a request payload cap. Rejected or throttled publishes SHALL store nothing. The publish gate SHALL additionally reject a same-name republish: a publish whose author already has a live (listed or unlisted) pack under the same name SHALL be rejected with a structured error that names the existing pack's identifier and the upgrade path (publish a new version under that identifier) — the gate creates no second registry entry for one author and one name. Administrative cleanup of pre-existing same-name duplicates SHALL go through the management face (unlist/retire), not through a publish-side exemption.

#### Scenario: Rapid publishes are throttled

- **WHEN** an author exceeds the per-author publish rate limit
- **THEN** further publishes are rejected with a throttling error and nothing is stored

#### Scenario: Same-name republish is rejected

- **WHEN** an author publishes a manifest named 柏讯 · 预期差 while their earlier pack under that exact name exists
- **THEN** the publish is rejected, nothing is stored, and the error names the existing pack's identifier and how to publish a new version instead

#### Scenario: Same name under a different author is allowed

- **WHEN** a different author publishes a pack whose name collides with another author's pack name
- **THEN** the publish proceeds (the guard is per-author, name collisions across authors are a curation matter)

## ADDED Requirements

### Requirement: Marketplace hygiene baseline

The public marketplace listing SHALL NOT present packs whose purpose is acceptance-testing, internal demo, or deployment verification; such packs SHALL be carried as unlisted (versions stay immutable and fetchable — an existing subscriber is never broken by hygiene actions, and unlisting SHALL NOT delete any version). Every public pack SHALL carry a curation category (empty only while triage is in flight); bringing the existing catalog up to this baseline is an operational task, not a code path. Duplicate-domain content (two live packs from the same author covering the same domain) SHALL be converged to a single line by the author or an admin via the management face — the publish guard prevents new duplicates, the management face retires old ones.

#### Scenario: Demo pack is unlisted, not deleted

- **WHEN** an admin unlists an acceptance-demo pack
- **THEN** it disappears from the public listing while its published versions remain fetchable by prior subscribers and the pack can be re-listed later

#### Scenario: Baseline sweep

- **WHEN** the hygiene baseline is checked against the catalog after the sweep task
- **THEN** no acceptance/demo pack is publicly listed and every public pack carries a category
