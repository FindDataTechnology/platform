# document-library-tools Delta

## Purpose

The agent-facing retrieval surface over the document library: three MCP tools (`list_library`, `search_library`, `read_document`) that let the chat agent discover, search, and read library files on demand during a conversation.

## ADDED Requirements

### Requirement: The library is exposed to the agent as MCP tools

The platform SHALL expose an in-process MCP server, registered through the existing MCP configuration channel, providing exactly three tools: `list_library`, `search_library`, and `read_document`. Tool names SHALL follow the platform's existing MCP naming convention (`mcp__<server>__<tool>`). If the MCP server fails to start, the chat runtime SHALL still start and the failure SHALL be logged.

#### Scenario: tools appear in the agent session

- **WHEN** a chat session starts with the library MCP server configured
- **THEN** the agent's tool roster includes the three library tools and can invoke them mid-conversation

#### Scenario: library unavailable does not break chat

- **WHEN** the library MCP server fails to initialize
- **THEN** the chat session starts and functions without library tools, and the failure is recorded in server logs

### Requirement: list_library enumerates the library

`list_library` SHALL return the documents in the library with id, name, type, and status, optionally filtered by collection. Collections SHALL be listed with their member document ids when no filter is given.

#### Scenario: listing the whole library

- **WHEN** the agent calls `list_library` with no arguments
- **THEN** every library document is returned with its metadata, grouped or annotated by collection where applicable

### Requirement: search_library performs lexical retrieval

`search_library` SHALL accept a query string and optional collection or document filters, and SHALL return ranked chunk hits with document name and a locator enabling follow-up reads. Results SHALL be capped at a documented maximum per call.

#### Scenario: scoped search

- **WHEN** the agent calls `search_library` with a query and a collection filter
- **THEN** only chunks of documents in that collection are searched and returned

### Requirement: read_document returns paged full text

`read_document` SHALL accept a document id and return its extracted text, paginated by a documented page size with a cursor or offset, so large documents can be read incrementally. Reading a nonexistent or non-ready document SHALL return a tool error the agent can act on.

#### Scenario: paging through a large document

- **WHEN** the agent calls `read_document` for a document longer than one page
- **THEN** the first page is returned with a cursor to the next page, and subsequent calls advance through the document in order

#### Scenario: unknown document

- **WHEN** the agent calls `read_document` with an id not in the library
- **THEN** the tool returns an error result indicating the document does not exist
