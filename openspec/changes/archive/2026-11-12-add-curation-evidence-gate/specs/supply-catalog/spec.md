## ADDED Requirements

### Requirement: Catalogued materials expose their curation evidence state

Every catalog entry SHALL expose a curation-evidence state — `已审` / `待复审` / `缺证据` (audited / review-due / evidence-missing) — derived from the entry's `evidence` object (per `curation-evidence`). Presenting surfaces SHALL render this state alongside the entry's provenance marks, and the state SHALL be derived at read time from the entry, never stored as a hand-maintained flag.

An entry whose state is `缺证据` or `待复审` SHALL still be listable (so an operator can see and fix it), but SHALL NOT be presented as available-for-supply, SHALL NOT be writable into a supply list, and SHALL NOT be reported as `available` or `enabled` in the three-state supply view. The catalogue's own admission rules are unchanged: this state is evidence bookkeeping, not a second admission gate.

#### Scenario: Evidence state is derived, not stored

- **WHEN** an entry's `reviewValidUntil` passes while its category and visibility are untouched
- **THEN** the next read reports `待复审` without any write to the entry

#### Scenario: Missing evidence blocks supply without hiding the entry

- **WHEN** the catalogue contains an entry with no `evidence` object
- **THEN** the storefront still lists it with state `缺证据`, and the supply list refuses to include it

#### Scenario: Evidence state does not restate admission

- **WHEN** an entry carries complete, unexpired evidence but fails its species' own admission rule (for example a plugin absent from the curated catalogue)
- **THEN** the catalog does not admit it on evidence alone — evidence state never overrides the species' source of truth
