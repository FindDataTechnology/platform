## MODIFIED Requirements

### Requirement: Marketplace hygiene baseline

The public marketplace listing SHALL NOT present packs whose purpose is acceptance-testing, internal demo, or deployment verification; such packs SHALL be carried as unlisted (versions stay immutable and fetchable — an existing subscriber is never broken by hygiene actions, and unlisting SHALL NOT delete any version). Every public pack SHALL carry a curation category (empty only while triage is in flight); bringing the existing catalog up to this baseline is an operational task, not a code path. Duplicate-domain content (two live packs from the same author covering the same domain) SHALL be converged to a single line by the author or an admin via the management face — the publish guard prevents new duplicates, the management face retires old ones. Re-listing SHALL be reachable by the pack's author through the ordinary publish path: publishing a new version of an unlisted pack SHALL restore its listing in the same operation, so an unlisted pack is never stranded and no operator database access is required to bring it back. Publishing SHALL NOT flip a pack's visibility class (public/private) — it clears the unlisted flag only.

#### Scenario: Demo pack is unlisted, not deleted

- **WHEN** an admin unlists an acceptance-demo pack
- **THEN** it disappears from the public listing while its published versions remain fetchable by prior subscribers and the pack can be re-listed later

#### Scenario: A new version restores listing

- **WHEN** the author of an unlisted pack publishes its next version
- **THEN** the new version is appended, the pack's unlisted flag clears, and the pack reappears in the public listing

#### Scenario: A non-author cannot restore listing by publishing

- **WHEN** anyone other than the pack's author attempts to publish a version against an unlisted pack
- **THEN** the publish is rejected as forbidden and the pack stays unlisted

#### Scenario: Publishing never changes visibility class

- **WHEN** a private pack's author publishes a new version
- **THEN** the pack stays private and remains absent from the public listing

#### Scenario: Baseline sweep

- **WHEN** the hygiene baseline is checked against the catalog after the sweep task
- **THEN** no acceptance/demo pack is publicly listed and every public pack carries a category
