## 1. Setup & Dependencies

- [x] 1.1 Add `@modelcontextprotocol/sdk` to `package.json` dependencies and run `npm install`
- [x] 1.2 Create `mcp.json` at project root with one example stdio server entry, and add a gitignored `mcp.example.json` template documenting the stdio + HTTP/SSE config shape
- [x] 1.3 Create a `skills/` directory with one sample `SKILL.md` (valid frontmatter: `name`, `description`) to exercise skill loading
- [x] 1.4 Add `mcp.json` and `skills/` handling to `.gitignore` as appropriate (keep `mcp.example.json` tracked)

## 2. MCP Bridge

- [x] 2.1 Create `mcp-bridge.js` exporting `connectMcpServers(configPath)` that reads `mcp.json` and returns a list of `{ client, tools }` plus a flat `ToolDefinition[]`
- [x] 2.2 Implement stdio transport connection using `StdioClientTransport` with a 10s handshake timeout per server
- [x] 2.3 Implement HTTP/SSE transport connection using `StreamableHTTPClientTransport` (auto-falling back to `SSEClientTransport` based on availability), with a 10s timeout
- [x] 2.4 For each remote tool, build a `ToolDefinition` with `parameters: Type.Unsafe(tool.inputSchema)`, matching `name`/`description`, and an `execute()` that proxies to `client.callTool({ name, arguments: params })` and maps the returned `content[]` into an `AgentToolResult`
- [x] 2.5 Wrap each `callTool` in a timeout that honors the passed `AbortSignal`, returning an error result on timeout or connection drop instead of hanging
- [x] 2.6 On any server connect/listTools failure, log a warning naming the server and continue without its tools (do not throw)

## 3. Server - Skills

- [x] 3.1 Add `additionalSkillPaths: ["./skills"]` to the `DefaultResourceLoader` options in `server.js`
- [x] 3.2 Handle the `list_skills` WS message: reply with `{ type: "skills", skills: [...] }` built from `loader.getSkills()`, each `{ name, description }`
- [x] 3.3 Detect prompts whose trimmed first token starts with `/skill:`; before forwarding, broadcast `{ type: "skill_use", name, args }` to all clients
- [x] 3.4 Forward `/skill:` prompts to `session.prompt()`; if the session does not expand the token (probe at runtime), fall back to looking up the skill content via `loader.getSkills()` and prepending it to the prompt

## 4. Server - Model Selection

- [x] 4.1 Handle the `list_models` WS message: reply with `{ type: "models", models: [...] }` from `modelRegistry.getAvailable()`, each `{ id, name, provider }`
- [x] 4.2 On a client's WebSocket `open`, send `{ type: "current_model", id }` using `session.model?.id`
- [x] 4.3 Handle the `set_model { id }` WS message: find the model in the registry, call `session.setModel(model)`, and broadcast `{ type: "model_changed", id }` to all clients
- [x] 4.4 Reject `set_model` while `isStreaming` is true: send an `error` message and leave the active model unchanged
- [x] 4.5 Reject `set_model` for an unknown model id: send an `error` message and leave the active model unchanged

## 5. Server - Tool & Skill Event Forwarding

- [x] 5.1 In the `tool_execution_start` handler, broadcast `{ type: "tool_start", name, args }` including the event's `args` field
- [x] 5.2 In the `tool_execution_end` handler, broadcast `{ type: "tool_end", name, result, isError }` including the event's `result` and `isError` fields
- [x] 5.3 (Optional) Forward `tool_execution_update` as `{ type: "tool_update", name, partialResult }` for streaming tool output
- [x] 5.4 Pass the MCP `customTools` from step 2.1 into `createAgentSession` so MCP tools appear in the same tool event stream

## 6. Frontend - Model Selector

- [x] 6.1 Add a `<select id="model-select">` dropdown to the header in `public/index.html`, disabled by default
- [x] 6.2 On WebSocket open, send `list_models`; populate the dropdown from the `models` response and pre-select the `current_model` id
- [x] 6.3 On dropdown change, send `{ type: "set_model", id }`; update the selected option on `model_changed` events from other clients
- [x] 6.4 Disable the dropdown while streaming (on `agent_start`) and re-enable on `done`

## 7. Frontend - Collapsible Tool Blocks

- [x] 7.1 Replace the one-line `.tool-indicator` rendering in `public/app.js` with a `.tool-block` matching the `.thinking-block` structure (toggle header + collapsible body)
- [x] 7.2 On `tool_start { name, args }`, render the block with header `🔧 <name>` and a running indicator; display the input `args` as formatted JSON in the body
- [x] 7.3 On `tool_end { name, result, isError }`, update the block to completed/error state and append the `result` to the body
- [x] 7.4 Wire the header click to toggle the body's collapsed/expanded state
- [x] 7.5 Add `.tool-block` styles in `public/style.css`: header, collapsible body, running/done/error variants, and a `max-height: 200px` scroll-bound body (reuse `.thinking-content` pattern)
- [x] 7.6 Handle the `tool_start`/`tool_end` pairing by `toolCallId` (added to the broadcast payloads) so concurrent tool calls render as separate blocks

## 8. Frontend - Collapsible Skill Blocks

- [x] 8.1 On `skill_use { name, args }`, render a `.skill-block` (collapsible, header `📘 Skill: <name>`, body showing `args`)
- [x] 8.2 Suppress echoing the raw `/skill:...` prompt as a normal user message when a `skill_use` event was emitted for it
- [x] 8.3 Add `.skill-block` styles in `public/style.css` consistent with `.tool-block` and `.thinking-block`
- [x] 8.4 (Optional) Add a skills hint/palette showing available skills from the `skills` response

## 9. End-to-End Testing

- [x] 9.1 Start the server with a valid `mcp.json`; verify it logs MCP server connections and starts even if a server fails
- [x] 9.2 Switch models from the dropdown; verify the active model changes and persists for subsequent prompts
- [x] 9.3 Prompt the agent to run a built-in tool (e.g. `bash`); verify the collapsible tool block shows input and output and toggles on click
- [x] 9.4 Prompt the agent to call an MCP tool; verify it appears as a collapsible tool block with input/output like built-in tools
- [x] 9.5 Type `/skill:<name> <args>`; verify a collapsible skill block renders and the raw slash text is not echoed as a user message
- [x] 9.6 Verify the dropdown is disabled mid-stream and re-enabled on `done`; verify `set_model` during streaming returns an error
- [x] 9.7 Verify error tool results render with error styling and large outputs are scroll-bounded
