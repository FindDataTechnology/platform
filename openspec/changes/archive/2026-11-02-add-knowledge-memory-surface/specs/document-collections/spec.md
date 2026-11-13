# document-collections Specification (delta)

## ADDED Requirements

### Requirement: Collection cards offer an agent-creation handoff
Each collection card SHALL offer a "用它造 agent" action that deep-links to the blueprint studio with a new draft prefilled so that `dataSources` references this collection (openspec: fleet-blueprint-studio's KB pinning requirement). The action SHALL NOT mint or materialize anything by itself; it seeds the draft the owner then edits, validates, and approves per the existing studio discipline. The existing "Save Collection" and "Start conversation" behaviors are unchanged.

#### Scenario: handoff seeds a studio draft
- **WHEN** the user activates "用它造 agent" on a collection card
- **THEN** the studio opens with a draft whose dataSources pin this collection, and the pinned source is visibly marked in the editor

#### Scenario: handoff is a seed, not a publish
- **WHEN** the user lands in the studio through the handoff and closes it without approving
- **THEN** no blueprint is saved, minted, or listed, and the collection is unchanged

#### Scenario: existing collection actions unaffected
- **WHEN** the user saves the collection or starts a conversation from the same card
- **THEN** both behave exactly as specified prior to this change
