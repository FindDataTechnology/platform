## Why

The web chat currently exposes a fixed set of read-only tools, a single hardcoded model, and flat one-line tool indicators. Users want the web agent to be as capable as a terminal agent: connect to **MCP servers** for external tools, load and invoke **skills**, and **switch models** at runtime. They also want visibility into what the agent is doing — tool calls and skill invocations should appear as **collapsible blocks** showing their inputs and outputs, not just a status line.

## What Changes

- **MCP integration**: Add an MCP bridge that connects to configured MCP servers (stdio + HTTP/SSE) on startup, discovers their tools, and registers each as a pi custom tool so the agent can call them like built-in tools. Configured via a `mcp.json` file at the project root.
- **Skill invocation**: Load skills from disk via the resource loader's `additionalSkillPaths` so they enter the agent's system prompt. Let users invoke skills by typing `/skill:name args` in the web input, and surface the invocation as a collapsible block.
- **Model selection**: List available models from the registry and let the user switch the active model at runtime via `session.setModel()`, exposed through a dropdown in the header.
- **Collapsible tool-use blocks**: Forward the tool `args` (input) on `tool_execution_start` and `result` (output) on `tool_execution_end` — fields the SDK already provides but the server currently discards — and render each tool call as a collapsible block with name, input, and output, replacing the flat one-line indicator.
- **Collapsible skill-use blocks**: Render skill invocations as collapsible blocks showing the skill name and arguments.

## Capabilities

### New Capabilities
- `mcp-integration`: Connect to MCP servers defined in `mcp.json`, bridge their tools as agent-callable custom tools, and reconnect on failure
- `skill-invocation`: Load skills from configured paths, list them to the client, invoke via `/skill:name args`, and report invocations as events for collapsible rendering
- `model-selection`: List available models and switch the active model at runtime, with the choice persisted for the session
- `tool-use-rendering`: Forward full tool execution detail (name, input, output, error) from server to client and render each tool call as a collapsible block

### Modified Capabilities
<!-- The base web-chat-server / web-chat-ui capabilities from the build-pi-web-chat change are not yet synced to openspec/specs/, so all new behavior is captured as new capabilities above. -->

## Impact

- **Dependencies**: add `@modelcontextprotocol/sdk` for MCP client connections
- **Modified files**: `server.js` (MCP bridge, skill loading, model-switch + list handlers, richer tool events), `public/app.js` (model selector, collapsible tool/skill blocks, skill listing), `public/index.html` (model selector dropdown, skill hint UI), `public/style.css` (collapsible block styles)
- **New files**: `mcp.json` (MCP server config, gitignored example), `skills/` directory (sample skill + discovery root)
- **No breaking changes** to existing chat behavior; the flat tool indicator is upgraded in place to a collapsible block
- **Risk**: MCP is not natively supported by the pi SDK — the bridge registers MCP tools as custom tools, so a failed MCP server must not block agent startup (graceful degradation with a logged warning)
