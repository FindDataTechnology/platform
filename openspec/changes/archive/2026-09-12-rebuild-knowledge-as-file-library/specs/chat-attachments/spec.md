# chat-attachments Delta

## MODIFIED Requirements

### Requirement: Attached documents are referenced in the outgoing prompt

The Composer SHALL attach a lightweight reference to each ingested document in the outgoing `prompt` WebSocket message. Server-side expansion SHALL inject, per referenced document, a bounded light context — document name, a short summary, and a pointer instructing the agent to use the library tools (`list_library` / `search_library` / `read_document`) for full content — instead of a source-text prefix. The reference SHALL NOT inline the file as base64; it SHALL point to the document in the library by id. The user-visible message SHALL keep the raw `@doc:<id>` references. A referenced document without available content SHALL expand to an explicit unavailability note.

#### Scenario: prompt carries a document reference

- **WHEN** the user sends a prompt that has one or more attached documents
- **THEN** the outgoing `prompt` message SHALL carry a reference (e.g. `@doc:<id>`) for each attached document
- **AND** the server SHALL expand the reference into light context (name, summary, tool pointers) before forwarding to the session

#### Scenario: attachment reference is not inlined

- **WHEN** a large file is attached
- **THEN** the prompt SHALL NOT embed the file as base64 in the WebSocket frame
- **AND** the expansion SHALL NOT inject the document's full source text; the agent retrieves full content on demand via the library tools

#### Scenario: prompt with no attachments is unchanged

- **WHEN** the user sends a prompt with no attached documents
- **THEN** the prompt SHALL be forwarded as today with no document expansion

#### Scenario: single-file attachment expansion

- **WHEN** a prompt carrying `@doc:<id>` for a ready document is sent
- **THEN** the agent-visible prompt contains the document's name, summary, and tool guidance, and does not contain the document's full source text

#### Scenario: collection hint injection

- **WHEN** a conversation is started from a collection
- **THEN** the initial context names the collection and its member documents and directs the agent to retrieve specifics with the library tools, without injecting member source text

#### Scenario: unavailable document

- **WHEN** a prompt references a document id with no retrievable content
- **THEN** the expansion states the document is unavailable so the agent can tell the user
