# tool-discovery Specification

## Purpose

Gives the agent a reliable way to discover and correct names for tools that are already available in its effective runtime roster, without changing MCP installation, authorization, or execution behavior.

## Requirements

### Requirement: Effective tool roster is searchable

The platform SHALL maintain a searchable representation of every tool currently available to the agent session, including built-in tools and tools contributed by effective MCP servers. Each indexed MCP tool SHALL expose its exact callable name, MCP server name, leaf tool name, description, and a concise parameter-schema summary. The index SHALL reflect the effective runtime profile: disabled servers, role-gated servers omitted for the current user, and servers omitted for missing credentials SHALL NOT appear. When the effective tool roster changes at runtime, the searchable representation SHALL be updated without requiring the agent session to be recreated.

#### Scenario: Mounted MCP tools are searchable

- **WHEN** the effective roster contains `mcp__fd-open-data-mcp__list_concepts`
- **THEN** searching the effective tools for `list_concepts` SHALL return that exact callable name
- **AND** the result SHALL identify `fd-open-data-mcp` as its MCP server and `list_concepts` as its leaf tool name

#### Scenario: Duplicate leaf names include their server context

- **WHEN** multiple effective MCP servers expose tools whose leaf names both match `list_concepts`
- **THEN** each result SHALL carry its distinct full callable name and server name
- **AND** the results SHALL NOT collapse into a single ambiguous entry

#### Scenario: Ineffective servers are omitted

- **WHEN** an installed MCP server is disabled, role-gated away from the current user, or omitted because its credential is missing
- **THEN** none of that server's tools SHALL appear in effective-tool search results

#### Scenario: Runtime hot-swap updates search results

- **WHEN** an MCP server is enabled, disabled, added, or removed through the existing effective-profile path
- **THEN** subsequent effective-tool searches SHALL reflect the new tool set without requiring a new chat session

### Requirement: Agent can resolve exact tool names before invocation

The platform SHALL provide the agent with a read-only tool lookup capability for searching the effective tool roster. The lookup SHALL accept a natural-language or partial-name query and return exact callable names ranked by relevance. It SHALL support at least leaf-name queries, full-name queries, server-scoped queries, separator-tolerant forms, and wildcard-like fragments. Lookup SHALL be read-only: it SHALL NOT call the discovered tool, install or mount an MCP server, mutate extensions, or expose credential material.

#### Scenario: Leaf-only MCP name resolves to full names

- **WHEN** the agent looks up `list_concepts`
- **THEN** the lookup SHALL return every effective tool whose leaf name matches, including names such as `mcp__fd-open-data-mcp__list_concepts`
- **AND** the response SHALL clearly identify the exact name required for invocation

#### Scenario: Separator mistakes still find candidates

- **WHEN** the agent looks up a fragment equivalent to `find data business list concepts` or `mcp__find_data-business-*`
- **THEN** the lookup SHALL be able to return matching effective tools from `fd-find-data-business-mcp`
- **AND** the response SHALL identify the separator-normalized exact callable name

#### Scenario: Server-scoped search narrows results

- **WHEN** the agent looks up `GDP indicator` scoped to `fd-find-data-business-mcp`
- **THEN** the lookup SHALL rank that server's matching tools ahead of tools from other servers
- **AND** results from unrelated servers SHALL not be presented as the best match

#### Scenario: Search is read-only

- **WHEN** the agent performs an effective-tool lookup
- **THEN** no MCP tool execution, extension mutation, credential read, or server installation SHALL occur
- **AND** only tool metadata needed to choose and invoke the tool by name SHALL be returned

#### Scenario: No effective match is explicit

- **WHEN** no effective tool matches the query
- **THEN** the lookup SHALL return an empty result rather than inventing a plausible MCP name
- **AND** the response SHALL indicate that the search covered only currently effective tools

### Requirement: Unknown tool calls provide candidate corrections

When an agent attempts to call a tool name that is not in the effective roster, the platform SHALL provide an agent-facing error that includes deterministic candidate corrections from the effective-tool search when plausible candidates exist. Candidate selection SHALL tolerate a missing MCP server segment, incorrect separators, extra wildcard characters, and leaf-name-only input. The error SHALL identify the attempted name and the exact candidate names; it SHALL NOT automatically invoke a candidate and SHALL NOT claim that a tool exists when no plausible candidate is found.

#### Scenario: Missing server segment is correctable

- **WHEN** the agent attempts to call `mcp__list_concepts` and the effective roster contains `mcp__fd-open-data-mcp__list_concepts`
- **THEN** the unknown-tool error SHALL include `mcp__fd-open-data-mcp__list_concepts` as a candidate
- **AND** the error SHALL state or imply that the attempted name was not the exact callable name

#### Scenario: Malformed server fragment is correctable

- **WHEN** the agent attempts a name derived from `mcp__find_data-business-*` while `fd-find-data-business-mcp` tools are effective
- **THEN** the unknown-tool error SHALL include relevant exact tool names from that server as candidates

#### Scenario: No candidate remains unambiguous

- **WHEN** an unknown tool name has no plausible match in the effective roster
- **THEN** the error SHALL still identify the attempted name as unknown
- **AND** it SHALL NOT fabricate or recommend an unrelated tool

#### Scenario: Suggestions do not execute

- **WHEN** an unknown-tool error includes one or more candidate names
- **THEN** the platform SHALL NOT automatically call any candidate
- **AND** any subsequent invocation SHALL occur only after the agent supplies the exact candidate name in a later tool call

### Requirement: Vertical-pack skills name primary tools exactly

Vertical-pack entry skills SHALL use exact effective callable tool names for the primary mounted tools behind each pack workflow. Intent-level guidance MAY remain as context and fallback, but a primary workflow step SHALL NOT rely solely on wildcard-like tool strings or omit the MCP server segment. When a named primary tool is absent from the effective roster, the skill SHALL instruct the agent to say that the required tool is unavailable rather than inventing a substitute.

#### Scenario: Primary data workflow names the callable tool

- **WHEN** a vertical-pack skill directs the agent to search World Bank indicators through `fd-find-data-business-mcp`
- **THEN** the skill content SHALL include the exact callable name for that primary tool, such as the server-qualified World Bank indicator search tool
- **AND** it SHALL NOT use only a wildcard such as `mcp__fd-find-data-business-mcp__*` as the invocation instruction

#### Scenario: Skill guidance handles an unavailable tool honestly

- **WHEN** a skill names a primary tool that is not present in the effective roster
- **THEN** the skill SHALL direct the agent to report that the required tool is unavailable
- **AND** the agent SHALL NOT be instructed to guess a similarly named replacement tool

### Requirement: Discovery is limited to already-effective tools

Tool discovery SHALL cover only tools already available through the platform's effective runtime profile. It SHALL NOT search, mount, install, proxy, or execute registry entries that are not effective. In particular, this capability SHALL NOT cause `airegistry-tools` to be installed or mounted and SHALL NOT create a chat-driven registry marketplace discovery flow.

#### Scenario: Unmounted registry server is not returned

- **WHEN** the registry contains `airegistry-tools` or another MCP server but that server is not part of the effective runtime profile
- **THEN** effective-tool discovery SHALL NOT return that server or its tools

#### Scenario: Discovery does not modify the marketplace

- **WHEN** the agent searches for or receives candidates from effective-tool discovery
- **THEN** no marketplace entry, extension record, MCP patch, credential, or runtime profile SHALL be modified
