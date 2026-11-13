## 1. Bridge skeleton

- [x] 1.1 Add `@deepseek-ai/dsh-sdk-client` (or resolve the dsh runtime binary) to `package.json`; verify `dsh --version` on PATH
- [x] 1.2 Create `dsh-bridge.js`: spawn dsh child with stdio pipes, newline-delimited JSON-RPC 2.0 framing (parse line buffer, send `\n`-terminated JSON), request/response id correlation
- [x] 1.3 Implement `initialize` handshake + a `ping`/health-check; child lifecycle: spawn on startup, unexpected-exit → restart-with-backoff (max retries ceiling), terminate on shutdown
- [x] 1.4 Wire `dsh-bridge.js` into `server.js` behind `AGENT_RUNTIME=pi|dsh` env flag (default `pi` for now); pi path untouched
- [x] 1.5 Confirm a trivial prompt round-trips: WS `prompt` → bridge JSON-RPC request → dsh response → (placeholder) WS `done`

## 2. Event translation seam

- [x] 2.1 Subscribe to dsh `session.event` / `session.status` notifications in the bridge
- [x] 2.2 Map `assistant/text` deltas → WS `text` event (exactly-once-per-turn; no re-broadcast on turn end)
- [x] 2.3 Map dsh turn completion (`session.status`) → WS `done` exactly once per turn
- [x] 2.4 Map dsh errors / child-crash-mid-turn → WS `error` then `done`; ensure streaming guard reset on the catch path (mirrors the failed-turn contract)
- [x] 2.5 Map `tool/*` start/update/end → WS `tool_start`/`tool_update`/`tool_end` with `name`, `args`, `result`, `isError`
- [x] 2.6 Log unmapped notifications at debug level (don't drop the turn); iterate the map against a live dsh runtime
- [x] 2.7 Preserve the streaming-reject guard: reject WS `prompt` while a turn is in flight (check is host-side, before forwarding to dsh)

## 3. LLM adapters + model selection

- [x] 3.1 Write a profile generator that emits Volces + LiteLLM llm adapter entries from env (`VOLCES_API_KEY`/`VOLCES_BASE_URL`, `LITELLM_BASE_URL`/`LITELLM_API_KEY`); OpenAI-compatible, `openai-completions` style
- [x] 3.2 Volces model list (deepseek-v4-pro, glm-5.2, …) declared in the adapter; LiteLLM models discovered from the proxy (short timeout, warn + continue on unreachable)
- [x] 3.3 Feed the bridge a `listModels`-equivalent RPC; re-source `EXPOSED_PROVIDERS` / model-list in `server.js` from dsh's reported list (delete `ModelRegistry` usage)
- [x] 3.4 `list_models` / `current_model` / `model_changed` WS messages behave identically (on-connect `current_model`, broadcast on change)
- [x] 3.5 `set_model` WS message + `/model` chat command → bridge JSON-RPC `setModel` request; streaming-reject guard preserved; unknown-model error preserved
- [x] 3.6 Graceful degradation: no Volces key + no LiteLLM → dsh starts with no llm adapter, server logs "chat non-functional", still serves static + REST

## 4. MCP + built-in tools via dsh plugins (delete custom code)

- [x] 4.1 Extend the profile generator to emit `dsh-mcp-client` server entries sourced from `mcp.json` + the SQLite MCP-config table (DB overrides on name collision)
- [x] 4.2 Add the OpenConnector `/mcp` server entry to the profile when `OPENCONNECTOR_BASE_URL` is set (runtime token as Bearer header)
- [x] 4.3 Add `dsh-tool-bash` + `dsh-tool-fs` (read/write/edit/grep) to the profile; confirm `mcp__<server>__<tool>` naming matches the existing convention
- [x] 4.4 DELETE `mcp-bridge.js` and built-in tool shims (`read`/`bash`/`grep`/`find`/`ls`) from `server.js` — pi path removed in 7.4; `mcp-bridge.js` + `litellm-models.js` deleted (dead code under dsh)
- [x] 4.5 Preserve "failed MCP server doesn't block startup" (dsh-mcp-client reconnect/hot-swap) and runtime add/remove/enable/disable (regenerate profile + signal dsh reload or restart)
- [x] 4.6 Preserve the MCP tools-in-allowlist invariant: confirm dsh exposes registered tool names so `server.js` can pass them to the session (or confirm dsh auto-allows profile tools)

## 5. Skills

- [x] 5.1 Confirm dsh skill plugin contract (profile `skillPaths` vs dedicated plugin); add skill paths to the profile
- [x] 5.2 Keep `/skill:<name> <args>` parsing, `skill_use` WS broadcast, and manual-expansion fallback in `server.js` (host protocol behavior)
- [x] 5.3 `list_skills` WS message served from the skill directory (same source as the profile entry); enabled/disabled + source (file|database) fields preserved

## 6. Catalog agent-local repoint

- [x] 6.1 `agent-local` catalog entry represents the dsh-backed session instead of the pi session; selection behavior unchanged
- [x] 6.2 `agent-remote` (OpenAI-compatible host streaming) and `app` entries + Nango broker untouched
- [x] 6.3 Remote-agent chat stays broadcast-only, not persisted to chat-history (v1 ceiling preserved)

## 7. Flip default + cleanup

- [x] 7.1 Flip `AGENT_RUNTIME` default to `dsh`; verify `npm start` brings up the full service (chat + models + MCP + skills + catalog)
- [x] 7.2 Run e2e tests against the dsh path; confirm no WS protocol / REST contract regressions
- [x] 7.3 Remove `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `pi-provider-litellm` from `package.json`
- [x] 7.4 Remove the `AGENT_RUNTIME` flag and the pi code path (only after 7.2 is green)
- [x] 7.5 `openspec validate migrate-pi-to-dsh`; update CLAUDE.md "Provider & model registration" + "mcp-bridge.js" sections to reflect the dsh bridge
