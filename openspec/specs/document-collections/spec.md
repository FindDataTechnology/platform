# document-collections Specification

## Purpose
Group uploaded documents into named collections so a chat turn can scope retrieval to a chosen subset of the knowledge base.

## Requirements

<!-- All requirements removed by bundle-weknora-knowledge change -->
<!-- WeKnora now handles document collections via its knowledge base system -->

### Requirement: Save collection button persists collection state

The server SHALL persist the collection state after documents are added. The "Save Collection" button SHALL trigger a save operation that ensures the collection and its document memberships are persisted to the database. A collection SHALL additionally support a "Start conversation" action that opens a new chat session with the collection's context attached as a light hint (see `chat-attachments`).

#### Scenario: save collection after adding documents

- **WHEN** user adds documents to a collection and clicks "Save Collection"
- **THEN** the collection and its memberships SHALL be persisted to the database
- **AND** the collection SHALL appear in the collections list with the correct document count

#### Scenario: start a conversation from a collection

- **WHEN** the user activates "Start conversation" on a collection card
- **THEN** a new chat session opens with the collection named and its member documents referenced for the agent to retrieve via library tools
