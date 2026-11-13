# document-library-tools Specification (Delta)

## MODIFIED Requirements

### Requirement: The library is exposed to the agent as MCP tools

The platform SHALL expose an in-process MCP server, registered through the existing MCP configuration channel, providing exactly four tools: `list_library`, `search_library`, `read_document`, and `fetch_document_file`. Tool names SHALL follow the platform's existing MCP naming convention (`mcp__<server>__<tool>`). If the MCP server fails to start, the chat runtime SHALL still start and the failure SHALL be logged.

#### Scenario: tools appear in the agent session

- **WHEN** a chat session starts with the library MCP server configured
- **THEN** the agent's tool roster includes the four library tools and can invoke them mid-conversation

#### Scenario: library unavailable does not break chat

- **WHEN** the library MCP server fails to initialize
- **THEN** the chat session starts and functions without library tools, and the failure is recorded in server logs

## ADDED Requirements

### Requirement: fetch_document_file delivers original bytes to the workspace

`fetch_document_file` SHALL accept a document id and write that document's original file bytes (as uploaded, before extraction) into the agent's workspace under the original filename, returning the workspace-relative path. A document whose original bytes are not retained (e.g. URL-ingested sources, or originals aged out) SHALL return an explicit tool error naming the document; the tool SHALL NOT fall back to returning extracted text as a file.

#### Scenario: original lands in the workspace

- **WHEN** the agent calls `fetch_document_file` with the id of a docx document in the library
- **THEN** the original .docx bytes appear in the agent's workspace under the original filename
- **AND** the tool returns the workspace-relative path for further processing (edit, convert, extraction)

#### Scenario: original not retained is an explicit error

- **WHEN** the agent calls `fetch_document_file` for a document whose original bytes were never stored
- **THEN** the tool returns an error result stating the original is unavailable for that document
- **AND** no file is written to the workspace

#### Scenario: unknown document

- **WHEN** the agent calls `fetch_document_file` with an id not in the library
- **THEN** the tool returns an error result indicating the document does not exist
