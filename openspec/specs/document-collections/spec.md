# document-collections Specification

## Purpose
Group uploaded documents into named collections so a chat turn can scope retrieval to a chosen subset of the knowledge base.

## Requirements

### Requirement: Save collection button persists collection state

The server SHALL persist the collection state after documents are added. The "Save Collection" button SHALL trigger a save operation that ensures the collection and its document memberships are persisted to the database. A collection SHALL additionally support a "Start conversation" action that opens a new chat session with the collection's context attached as a light hint (see `chat-attachments`).

#### Scenario: save collection after adding documents

- **WHEN** user adds documents to a collection and clicks "Save Collection"
- **THEN** the collection and its memberships SHALL be persisted to the database
- **AND** the collection SHALL appear in the collections list with the correct document count

#### Scenario: start a conversation from a collection

- **WHEN** the user activates "Start conversation" on a collection card
- **THEN** a new chat session opens with the collection named and its member documents referenced for the agent to retrieve via library tools

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
