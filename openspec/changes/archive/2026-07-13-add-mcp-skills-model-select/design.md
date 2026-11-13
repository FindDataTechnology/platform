## Context

`pi-web-chat` is a single-file Express + WebSocket wrapper around the pi SDK (`@earendil-works/pi-coding-agent` v0.80.6). Today it creates one `AgentSession` at startup with a hardcoded set of read-only tools (`read`, `bash`, `grep`, `find`, `ls`) and a fixed provider (`volces`) with three models, of which the first listed is used. Tool executions surface to the browser as one-line `tool_start` / `tool_end` indicators carrying only the tool name. Skills are not loaded, MCP is not connected, and the model cannot be changed without editing `server.js`.

Research into the SDK's `.d.ts` files established the following hard constraints that shape this design:

- **MCP is not supported by the SDK.** There is no `mcpServers` option anywhere in `CreateAgentSessionOptions`, `DefaultResourceLoaderOptions`, or the extension API. The only extension point for adding tools is `pi.registerTool(ToolDefinition)` or the `customTools: ToolDefinition[]` option on `createAgentSession`.
- **Skills are supported** via `DefaultResourceLoaderOptions.additionalSkillPaths` (or `skillsOverride`). Skills are SKILL.md text expansions injected into the system prompt or expanded when a user types `/skill:name args`. There are no skill-specific runtime events.
- **Models can be switched at runtime** via `session.setModel(model: Model)`. Available models are listed via `ModelRegistry.getAvailable()` (auth-configured) or `getAll()`.
- **Tool events already carry input and output** that the server currently discards: `tool_execution_start` has `args`, `tool_execution_end` has `result` and `isError`, and `tool_execution_update` has `partialResult`. The collapsible-block feature therefore needs no SDK change - only forwarding.
- **`ToolDefinition`** requires `name`, `label`, `description`, a TypeBox `parameters` schema, and an `async execute(toolCallId, params, signal, onUpdate, ctx)` returning `AgentToolResult`. TypeBox's `Type.Unsafe(jsonSchema)` can wrap an MCP tool's `inputSchema` verbatim.

## Goals / Non-Goals

**Goals:**
- Let the agent call tools from any MCP server configured in a `mcp.json`, indistinguishably from built-in tools.
- Load skills from disk and let the user invoke them via `/skill:name args` from the web input.
- Let the user switch the active model at runtime from a dropdown in the header.
- Render every tool call and every skill invocation as a collapsible block showing its inputs and outputs.
- Keep the zero-build, single-`node server.js` deployment story.

**Non-Goals:**
- OAuth/authenticated MCP servers (initial scope: stdio + bearer-token HTTP/SSE).
- Dynamically adding/removing MCP servers without restarting the server.
- Skill authoring UI or skill marketplace - skills are authored as SKILL.md files on disk.
- Per-user model preferences or persistence across server restarts (in-memory only, matching the existing session model).
- Migrating the flat tool indicator for legacy clients - the browser is the only client.

## Decisions

### 1. MCP bridge via `@modelcontextprotocol/sdk`, registered as `customTools`

**Choice.** Add the official `@modelcontextprotocol/sdk` dependency. In `initAgent()`, before `createAgentSession`, connect to every server in `mcp.json`, call `client.listTools()`, and for each remote tool build a `ToolDefinition` whose `parameters` is `Type.Unsafe(tool.inputSchema)` and whose `execute()` proxies to `client.callTool({ name, arguments: params })`, mapping the returned `content[]` into `AgentToolResult`. Pass the resulting array as `customTools` in `createAgentSession`.

**Why.** The SDK has no native MCP, but it has a first-class custom-tool mechanism. Bridging through `ToolDefinition` means MCP tools flow through the *same* `tool_execution_start`/`tool_execution_end` events as built-in tools - so they render as collapsible blocks for free and need no separate UI path. Using `customTools` (static, resolved before session creation) is simpler than an extension factory with `pi.registerTool` (deferred registration), because all MCP tools are known once `listTools()` resolves at startup.

**Alternatives considered.** (a) Write a pi extension that calls `pi.registerTool` lazily after MCP connects - rejected: adds async-registration complexity for no benefit, since startup-time discovery is sufficient. (b) Spawn MCP servers outside the agent and expose them via a separate tool namespace - rejected: loses the unified tool-call event stream that powers the collapsible UI.

### 2. `mcp.json` config with stdio + HTTP/SSE, graceful degradation

**Choice.** A `mcp.json` at the project root mirrors Claude Code's format:
```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "context7": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
  }
}
```
Stdio servers use `StdioClientTransport`; HTTP/SSE servers use `StreamableHTTPClientTransport` (falling back to `SSEClientTransport`). Each server connects with a 10s timeout. A failed server is logged and skipped; it does **not** abort startup, and its tools are simply absent from the session.

**Why.** Stdio covers local tool servers (the common case for a dev box); HTTP/SSE covers remote/managed servers. Graceful degradation matters because MCP servers are independent processes that can misconfigure or crash, and the chat must still start.

### 3. Skills via `additionalSkillPaths`; `/skill:name` passthrough + `skill_use` event

**Choice.** Add `additionalSkillPaths: ["./skills", ...]` to the `DefaultResourceLoader` so skills enter the system prompt and the agent's slash-command table. When the server receives a prompt beginning with `/skill:`, it broadcasts a `skill_use` event `{ name, args }` to all clients *before* forwarding the text to `session.prompt()` (which expands the skill). If `session.prompt()` does not expand a given `/skill:` token, the server falls back to looking up the skill content from `loader.getSkills()` and prepending it to the prompt.

**Why.** Skills are text expansion with no runtime events, so the only way to render a "skill was invoked" block is for the server to detect the `/skill:` prefix and emit its own event. Loading via `additionalSkillPaths` is the SDK-blessed path and keeps skills in the system prompt so the model can also reference them.

**Alternatives considered.** Require a dedicated "Run skill" button instead of `/skill:` syntax - rejected: breaks parity with the terminal where `/skill:name` is the idiom and forces a separate input mode.

### 4. Model selection via `session.setModel` + header dropdown

**Choice.** Expose two new WS message types: `list_models` (server replies with `models` payload from `modelRegistry.getAvailable()` filtered to configured providers, each `{ id, name, provider }`) and `set_model` (server calls `session.setModel(model)`, replies `model_changed` with the new model id or `error`). The active model id is sent on connect (`current_model`). The header gains a `<select>` populated from `list_models`; changing it sends `set_model`.

**Why.** `setModel` is the SDK's supported runtime switch and validates auth. Filtering to `getAvailable()` avoids offering models the user cannot call. Sending `current_model` on connect lets the dropdown show the right initial state.

### 5. Collapsible tool-use blocks: forward `args`/`result`, render like the thinking block

**Choice.** Augment the existing `tool_start` broadcast to include `args` (from `tool_execution_start.args`) and `tool_end` to include `result` and `isError` (from `tool_execution_end`). The frontend replaces the one-line `.tool-indicator` with a `.tool-block` mirroring the existing `.thinking-block` structure: a toggle header (`🔧 <name>`) and a collapsible body showing `Input:` (JSON) and `Output:` (text/JSON). The block is collapsed by default while running, auto-expands to show input on start, and appends output on end. Errors render with the error style. Large outputs are truncated in the body with a max-height scroll (reusing `.thinking-content`'s `max-height: 200px`).

**Why.** The SDK already provides the data; the server just stopped forwarding it. Reusing the thinking-block DOM pattern keeps the CSS and interaction model uniform. Collapsed-by-default keeps the conversation readable while streaming.

### 6. Collapsible skill-use blocks via the `skill_use` event

**Choice.** The frontend renders the `skill_use` event as a `.skill-block` (same collapsible pattern, header `📘 Skill: <name>`), showing the invocation arguments in the body. It appears in place of (and suppresses) the echo of the raw `/skill:...` user message, so the user sees a clean skill-invocation card instead of literal slash-command text.

**Why.** Consistent with tool blocks; signals to the user that a skill was expanded rather than sent verbatim.

### 7. WS protocol additions (summary)

From client: `list_models`, `set_model { id }`, `list_skills`. From server: `current_model { id }`, `models [ {id,name,provider} ]`, `model_changed { id }`, `skills [ {name,description} ]`, `skill_use { name, args }`, `tool_start { name, args }`, `tool_end { name, result, isError }`. Existing messages (`prompt`, `text`, `thinking`, `done`, `error`, `user`) unchanged.

## Risks / Trade-offs

- **[MCP server blocks or crashes mid-call]** -> `execute()` honors the passed `AbortSignal` and wraps `callTool` in a timeout; a crashing server's tools return an error result (rendered in the collapsible block) rather than hanging the agent.
- **[No native MCP = maintenance burden]** -> The bridge is ~150 lines in one module (`mcp-bridge.js`); if the SDK adds native MCP later, this module is deleted and `mcpServers` is passed to `createAgentSession`. The `mcp.json` format already matches the likely native shape.
- **[MCP `inputSchema` is arbitrary JSON Schema, TypeBox `Type.Unsafe` skips validation]** -> The agent still receives the schema in its tool definition (so it knows the shape); we accept that the SDK will not validate params server-side. Acceptable for a trusted local dev tool.
- **[Skill `/skill:` detection is string-prefix based]** -> Only prompts whose trimmed first token starts with `/skill:` are treated as skill invocations; everything else is a normal prompt, so false positives are limited to literal slash text.
- **[Model switch mid-stream]** -> `setModel` while `isStreaming` could interrupt a turn. Mitigation: disable the dropdown while streaming (the frontend already tracks streaming state); re-enable on `done`.
- **[Tool `result` may be large or binary]** -> Collapsible body truncates to a scrollable max-height; image content is rendered as a data URL only if small, otherwise a placeholder.

## Migration Plan

1. `npm install @modelcontextprotocol/sdk`.
2. Add `mcp-bridge.js`, `mcp.json` (with a gitignored `mcp.example.json`), and a `skills/` directory with one sample SKILL.md.
3. Update `server.js` to load the bridge, pass `customTools`, add `additionalSkillPaths`, wire the new WS handlers, and enrich `tool_start`/`tool_end` payloads.
4. Update `public/index.html`, `public/app.js`, `public/style.css` for the dropdown and collapsible blocks.
5. Smoke test each feature independently: switch model, run a built-in tool (see collapsible block), invoke `/skill:`, call an MCP tool.
6. Rollback: revert `server.js` and `public/`; remove `mcp-bridge.js` and the dependency. No data migration is involved (in-memory session).

## Open Questions

- Exact transport classes for the installed `@modelcontextprotocol/sdk` version (`StreamableHTTPClientTransport` vs legacy `SSEClientTransport`) - confirm via Context7 at implementation time and auto-detect by availability.
- Whether `session.prompt("/skill:name args")` expands skills in this SDK version or only `steer`/`followUp` do - verify in a quick runtime probe; the design's fallback (manual lookup + prepend) covers the no-expansion case.
- Whether to surface MCP server connection status in the header (nice-to-have) - defer to a follow-up unless trivial.
