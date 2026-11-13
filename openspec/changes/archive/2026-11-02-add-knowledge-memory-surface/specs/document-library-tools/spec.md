# document-library-tools Specification (delta)

## MODIFIED Requirements

### Requirement: The library is exposed to the agent as MCP tools

The platform SHALL expose an in-process MCP server, registered through the existing MCP configuration channel, providing exactly four tools: `list_library`, `search_library`, `read_document`, and `fetch_document_file`. Tool names SHALL follow the platform's existing MCP naming convention (`mcp__<server>__<tool>`). The tools SHALL be mounted not only in interactive chat lanes but also in agent-team execution turns and in 智语 rooms' deployed members, via the execution-side convergence point for lane tool supply (one mount, not per-path writers); mounting into a deployment member's cell SHALL pass the existing dsh tool-supply whitelist gate. If the MCP server fails to start, the lane runtime SHALL still start and the failure SHALL be logged.

#### Scenario: tools appear in the agent session

- **WHEN** a chat session starts with the library MCP server configured
- **THEN** the agent's tool roster includes the four library tools and can invoke them mid-conversation

#### Scenario: library unavailable does not break chat

- **WHEN** the library MCP server fails to initialize
- **THEN** the chat session starts and functions without library tools, and the failure is recorded in server logs

#### Scenario: fleet turn carries the library tools

- **WHEN** an agent-team execution turn starts for a member whose cell has the library server whitelisted
- **THEN** the member's tool roster includes the four library tools

#### Scenario: summoned room member carries the library tools

- **WHEN** a fleet is summoned into a 智语 room via the existing one-click bring-team flow
- **THEN** the deployed members can invoke library tools inside room turns, subject to the retrieval boundary

## ADDED Requirements

### Requirement: Retrieval is bounded by project, enforced server-side
Library tool results SHALL be bounded by the turn's project attribution: when a project context is active, `list_library`, `search_library`, and `read_document` SHALL cover only collections attributed to that project plus shared collections; reads outside the boundary SHALL return an act-on-able tool error and SHALL NOT leak names, counts, or content of out-of-bound documents. When no project context exists (account-level legacy sessions), the tools SHALL cover the account library as today. The boundary SHALL be enforced in the tool server, not in prompt text.

#### Scenario: fleet turn sees its project plus shared only
- **WHEN** a member attributed to project P calls `list_library`
- **THEN** only P's collections and shared collections appear, and a `read_document` for an out-of-bound id errors without confirming existence

#### Scenario: unattributed session keeps the full account library
- **WHEN** a session with no project attribution calls `search_library`
- **THEN** results span the whole account library, matching pre-boundary behavior

### Requirement: Anonymous guest lanes never receive library tools
Lanes serving anonymous or embedded-guest traffic SHALL NOT mount the library MCP server; the tool roster presented in those sessions contains no `mcp__library__*` entries.

#### Scenario: guest widget roster is library-free
- **WHEN** a visitor chats through the website embed guest widget
- **THEN** no library tool appears in the roster and any forged tool call is rejected
