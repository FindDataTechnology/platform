## MODIFIED Requirements

### Requirement: Four emit targets produce defined artifacts from one document

The system SHALL support four targets from a single Agent Document: **personal preset** (cell-local, no publish gate), **pack draft** (enters the market publish gate), **fleet template** (enters template instantiation/deploy), and the **blueprint pipeline** (validate → approve → cast → trial → signoff → iterate). The Agent Document's persistent form SHALL be the owner's blueprint draft record, carrying an explicit kind (`agent` | `team`): the composition editor always works on a persisted, autosaved draft, and the blueprint pipeline advances **that same record** rather than a copy. Each emit target SHALL re-validate at emit time and SHALL produce an artifact of its own declared lifecycle; the document itself SHALL NOT be mutated by an emit. Autosaving the draft SHALL NOT create any market, cast, or cluster artifact.

#### Scenario: Emit to a cell-local preset

- **WHEN** a document is emitted as a personal preset
- **THEN** the preset is stored cell-locally with no publish gate and is not visible to other users

#### Scenario: Emit to a pack draft

- **WHEN** a document is emitted as a pack draft
- **THEN** it enters the existing publish gate and, on publish, becomes a versioned market entry subject to the marketplace's immutability rules

#### Scenario: Emit to a blueprint

- **WHEN** a document's team pipeline advances (approve / cast / trial / signoff / reseal)
- **THEN** the gates operate on the same persisted draft record — no second copy is created — the record SHALL NOT be castable before approval, and the trial stage runs only against a cast artifact (先有包才能装台)

#### Scenario: Autosave persists, not emits

- **WHEN** edits autosave the working document
- **THEN** only the owner's draft record changes; no market entry, cast manifest, or cluster appears
