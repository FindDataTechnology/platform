## MODIFIED Requirements

### Requirement: dsh runtime is configured via a profile that composes core plugins

The server SHALL pass the dsh runtime a profile/bundle configuration (or CLI flags) that composes: `core/session`, `core/agent-loop`, `core/tools`, `dsh-tool-bash`, `dsh-tool-fs` (read/write/edit/grep), `dsh-mcp-client`, and the platform's Volces llm adapter. The profile SHALL be the single source of which plugins the runtime loads; the server SHALL NOT duplicate tool or MCP wiring in JavaScript. The profile SHALL also compose the retained-output budget (`dsh-spill-policy` `maxInlineTokens`): the server SHALL write that row with a bounded inline budget (default 4000 tokens, operator-tunable), because a single tool result or assistant message was measured at 40–43 KB — 79–87% of an overflowing fleet round — and the stock 12500-token budget lets two such results consume a fifth of a 128K window. Text beyond the inline budget SHALL continue to spill to disk with a reference, so the budget costs a re-read, never the information.

#### Scenario: profile composes built-in tools
- **WHEN** the dsh runtime starts with the platform profile
- **THEN** bash, fs read/write/edit/grep, and MCP tools SHALL be available to the agent via dsh plugins, with no custom tool-bridge code in the server

#### Scenario: profile composes MCP client
- **WHEN** the profile includes `dsh-mcp-client` and a server config is provided
- **THEN** MCP tools SHALL be registered with `mcp__<serverName>__<toolName>` names by the dsh plugin, not by server-side JavaScript

#### Scenario: profile carries the inline budget

- **WHEN** the server composes the dsh profile
- **THEN** the profile's patch carries exactly one `spill-policy` row with a positive `maxInlineTokens` (default 4000), replacing any stale value rather than duplicating the row

#### Scenario: budget is operator-tunable and never zero

- **WHEN** the deployment sets the inline-budget override to a positive integer
- **THEN** that value is written verbatim; a non-numeric or non-positive value falls back to the default, never to zero (zero would suppress every result body)

