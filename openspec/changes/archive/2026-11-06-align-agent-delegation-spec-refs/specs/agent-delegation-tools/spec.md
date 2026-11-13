# agent-delegation-tools 引用方式修正

## ADDED Requirements

（无）

## MODIFIED Requirements

### Requirement: Delegation tools are available to all personas
Every persona preset SHALL have access to delegation tools — delegate, progress, result — exposed through the cell's local MCP configuration alongside the scheduling tools, plus the market-agent discovery tool `search_agents` (openspec: agent-delegation-a2a). The short names above are prose aliases; the registered MCP tool names are `delegate_task`, `task_progress`, and `task_result`, registered in `server/delegation-mcp.js` (tool-definition entries, referenced by name — line numbers intentionally not pinned). The tools SHALL operate only on tasks of the cell they run in.

#### Scenario: Tool visible to a persona

- **WHEN** a persona lists its available tools
- **THEN** the four delegation tools (delegate, progress, result, search_agents) are present regardless of the active preset
