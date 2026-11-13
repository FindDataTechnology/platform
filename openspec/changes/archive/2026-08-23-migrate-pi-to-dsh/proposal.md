## Why

`@earendil-works/pi-coding-agent` is a fast-moving SDK we don't control, and several Platform modules duplicate capabilities that DeepSeek Harness (dsh) already ships as maintained plugins — `mcp-bridge.js` re-implements what `dsh-mcp-client` does, built-in tool shims duplicate `dsh-tool-bash`/`dsh-tool-fs`, and `SessionManager` usage overlaps `core/session`. Migrating lets us delete custom bridge code, track a stable plugin contract instead of an internal SDK, and align with dsh's "Everything is a Plugin" model. The user has decided on **Shape B** (subprocess): server.js stays buildless plain-JavaScript ESM, spawns the dsh runtime as a stdio JSON-RPC child, and translates dsh events onto the existing WebSocket contract — preserving the "no build step" convention and the React frontend's protocol unchanged.

## What Changes

- **BREAKING (internal only)**: the agent runtime backing the shared chat session changes from an in-process pi `AgentSession` to a dsh runtime subprocess driven over newline-delimited JSON-RPC stdio. The WebSocket protocol the frontend speaks is **unchanged** (`prompt`, `text`, `tool_start/end`, `skill_use`, `models`, `done`, `error`, etc.).
- Add `dsh-bridge.js`: a stdio JSON-RPC client that spawns the dsh runtime, sends `prompt`/`setModel`/`listModels`/etc. requests, and subscribes to `session.event`/`session.status` notifications. An event-translation seam maps dsh `turn/*`, `assistant/*`, `tool/*`, `execute` notifications onto the existing `broadcast()` WS events.
- **DELETE** `mcp-bridge.js` and built-in tool shims — replaced by dsh's `dsh-mcp-client` and `dsh-tool-bash`/`dsh-tool-fs` plugins, configured in the dsh profile. MCP tool naming (`mcp__<server>__<tool>`) is preserved because dsh uses the identical convention.
- Replace the `pi-provider-litellm` extension and the in-process Volces provider registration with dsh LLM adapters (OpenAI-compatible) declared in the dsh profile; `server.js`'s `EXPOSED_PROVIDERS` model-list logic is fed from dsh's model list instead of the pi `ModelRegistry`.
- Replace `additionalSkillPaths` (pi resource loader) with a dsh skill plugin / profile entry; `/skill:<name>` expansion behavior is preserved.
- `agent-remote` (catalog remote chat) streaming stays in `server.js` (host-level, OpenAI-compatible) — dsh backs only the `agent-local` session.
- `documents.js` RAG, `open-connector.js` host proxy, `chat-history.js`, `catalog.js` host side, and the `/oc-web` + `/litellm-web` reverse proxies are **unchanged** — they are host-level modules that talk HTTP/SQLite, not pi internals. The OpenConnector MCP registration moves from the host MCP-connect step to the dsh profile's `dsh-mcp-client` config.
- **Scope ceiling**: v1 swaps the **local agent** runtime only. Remote-agent chat, documents RAG, catalog, auth, and bundled-service supervision are untouched. The WS protocol is frozen; no frontend changes are required for the migration to function.

## Capabilities

### New Capabilities
- `dsh-runtime-bridge`: the stdio JSON-RPC subprocess bridge to the dsh runtime — spawning, request/response, notification subscription, and the event-translation seam that maps dsh `session.event`/`session.status` notifications onto the existing WebSocket event vocabulary. This is the single new module; everything else is a modification.

### Modified Capabilities
- `web-chat-server`: the "Server creates and manages a pi agent session" requirement changes to creating/managing a dsh runtime session via the bridge; the WS `prompt`→`text`/`done`/`error` contract is preserved, but the session is a subprocess, not an in-process SDK object. Graceful-degradation ("starts when no provider configured") is preserved through the dsh profile's optional adapters.
- `mcp-integration`: the "registered as a pi ToolDefinition" mechanism is replaced by dsh's `dsh-mcp-client` plugin (same `mcp__<server>__<tool>` naming); `mcp.json` + DB config loading stays host-side and feeds the dsh profile. The "failed servers don't block startup" and runtime add/remove requirements are preserved by dsh-mcp-client's reconnect/hot-swap behavior.
- `litellm-provider`: registration via `pi-provider-litellm` extension is replaced by a dsh LLM adapter (OpenAI-compatible) in the profile; `LITELLM_BASE_URL`/`LITELLM_API_KEY` env wiring, the `litellm` provider name, model discovery, and the `/ui` management link are unchanged.
- `model-selection`: the model list source changes from the pi `ModelRegistry` to dsh's reported model list, surfaced through the bridge; `list_models`/`set_model`/`current_model`/`model_changed` WS messages and the `/model` chat command behave identically. Streaming-reject guard is preserved.
- `skill-invocation`: `additionalSkillPaths` (pi resource loader) is replaced by a dsh skill plugin/profile entry; `/skill:<name>` invocation, the `skill_use` WS event, manual-expansion fallback, and the `list_skills` message are preserved.
- `agent-catalog`: the `agent-local` entry now represents the dsh-backed session instead of the pi session; `agent-remote` and `app` entries, dual-source merge, role filtering, and the Nango broker are unchanged.
- `open-connector`: the OpenConnector `/mcp` endpoint registration moves from the host MCP-connect step to the dsh profile's `dsh-mcp-client` config; the host `/api/openconnector/*` proxy and `/oc-web` reverse proxy are unchanged. "Tools added to the allowlist" becomes "tools available via dsh-mcp-client"; the failure-doesn't-block invariant is preserved.

## Impact

- **server.js**: the `extensionFactories`, `createAgentSession`, `SessionManager`, `ModelRegistry`, `DefaultResourceLoader` imports from `@earendil-works/pi-coding-agent` are removed; replaced by `dsh-bridge.js` calls. `broadcast()` event handlers rewritten to consume translated dsh events. `EXPOSED_PROVIDERS`/model-list path fed from dsh. `agent-remote` streaming path untouched.
- **NEW `dsh-bridge.js`**: the subprocess + JSON-RPC client + event translator (the one new file). Mirrors the `fd-pi-bridge/bridge.js` stdio pattern already proven in this workspace.
- **DELETE**: `mcp-bridge.js`; built-in tool shims for `read`/`bash`/`grep`/`find`/`ls` (now dsh plugins). `pi-provider-litellm` import removed.
- **dsh profile** (`dsh.profile.json` or equivalent): declares the Volces + LiteLLM LLM adapters, `dsh-mcp-client` servers (from `mcp.json` + DB + OpenConnector `/mcp`), `dsh-tool-bash`/`dsh-tool-fs`, and skill paths. Generated/written at startup from env, the same way `mcp.json` is today.
- **package.json**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `pi-provider-litellm` removed; `@deepseek-ai/dsh-sdk-client` (or the runtime binary) added.
- **UNCHANGE**D: `documents.js`, `chat-history.js`, `catalog.js` (host side), `open-connector.js` (host proxy), `db.js`, `bundle-manifest.js`, `electron/` supervisor, `web/` frontend, WS protocol, REST API contracts. No frontend changes required for the migration to function.
- **Risk**: dsh is a developer preview (breaking changes possible); the bridge isolates this — a dsh runtime swap or protocol bump touches only `dsh-bridge.js`. Rollback is restoring the pi imports (kept until the migration is archived).
- **CI**: `npm start` / electron supervisor spawn the dsh runtime as a new child; `resources/` may gain a bundled dsh binary in a later change (out of scope here — v1 uses an installed/path-resolved runtime).
