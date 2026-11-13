## Context

Platform today hosts one in-process `pi` `AgentSession` (`@earendil-works/pi-coding-agent`) inside `server.js`. A `DefaultResourceLoader` registers providers (Volces + optional LiteLLM via `pi-provider-litellm`), skills (`additionalSkillPaths`), and MCP servers (`mcp-bridge.js` connects each `mcp.json` entry and wraps every MCP tool as a pi `ToolDefinition`). Agent events are subscribed and re-broadcast over a single WebSocket as typed events (`text`, `tool_start/end`, `skill_use`, `models`, `done`, `error`). The React frontend speaks only that WS protocol; it has no knowledge of pi internals.

DeepSeek Harness (dsh) is a Cordis-based agent runtime where "Everything is a Plugin" — core/session, core/agent-loop, core/tools, an llm adapter seam, `dsh-tool-bash`, `dsh-tool-fs`, `dsh-mcp-client` (which already uses the identical `mcp__<serverName>__<toolName>` naming convention), and a skill plugin. It exposes a newline-delimited JSON-RPC 2.0 stdio transport (`session.event`, `session.status`, `subagent.*` notifications; `prompt` returns a message id). This means most of what Platform hand-rolls in JavaScript is already a maintained dsh plugin.

The user picked **Shape B** (subprocess) over Shape A (embedded/Cordis-in-process) to preserve two project invariants: **server.js stays buildless plain-JavaScript ESM** (no TypeScript, no transpiler), and the **frontend WS contract is frozen**. The bridge pattern is already proven in this workspace by `fd-pi-bridge/bridge.js`, which spawns `pi --mode rpc` over the same kind of stdio JSONL transport.

## Goals / Non-Goals

**Goals:**
- Back the local chat agent with a dsh runtime subprocess driven over JSON-RPC stdio.
- Delete `mcp-bridge.js` and built-in tool shims (replaced by `dsh-mcp-client`, `dsh-tool-bash`, `dsh-tool-fs`).
- Replace `pi-provider-litellm` + the in-process Volces provider registration with dsh llm adapters declared in a profile.
- Keep the WebSocket protocol, REST API contracts, and React frontend **byte-for-byte unchanged** — the migration is invisible to the browser.
- Keep `documents.js`, `chat-history.js`, `catalog.js` (host side), `open-connector.js` (host proxy), `db.js`, `electron/`, and bundled-service supervision **untouched**.
- Isolate the dsh developer-preview risk behind a single seam (`dsh-bridge.js`) so a runtime swap or protocol bump is a one-file change.

**Non-Goals:**
- Bundling a dsh binary into `resources/` (v1 uses a PATH-resolved / configured runtime; bundling is a later change).
- Migrating `agent-remote` chat (OpenAI-compatible host streaming) or the Nango broker to dsh — those stay host-side.
- Per-user / per-connection agent sessions (the shared-session v1 ceiling is preserved).
- Touching the frontend, WS protocol, or REST contracts.
- Migrating documents RAG *into* dsh as a tool — it stays a host module with its own REST + WS events.

## Decisions

### D1. Subprocess + JSON-RPC stdio (Shape B), not embedded Cordis

**Why:** preserves the "buildless plain-JS ESM" invariant (server.js cannot `import` a TypeScript Cordis ctx without a build step), and matches the `fd-pi-bridge/bridge.js` pattern already in this workspace. The dsh runtime is the only TypeScript process; it lives in the subprocess and is isolated.

**Alternative considered:** Shape A — server.js composes a Cordis `ctx` directly, platform becomes a TS project. Rejected: forces a build step + transpiler onto a project that explicitly has none, and couples the server's event loop to dsh's Cordis internals (a breaking change in dsh then ripples through server.js instead of one bridge file).

### D2. The bridge is the single translation seam

`dsh-bridge.js` owns: (1) child-process lifecycle (spawn / health-check / restart-with-backoff / shutdown), (2) JSON-RPC request/response correlation, (3) notification subscription, and (4) the event-translation map (dsh `session.event`/`session.status` → existing WS `text`/`tool_*`/`done`/`error`). Nothing else in `server.js` imports or knows about dsh protocol details. This is the rollback unit: restore the pi imports and delete `dsh-bridge.js` and the migration reverses.

### D3. Profile, not JavaScript, composes plugins

The dsh runtime receives a profile/bundle (JSON file or CLI flags, generated at startup from env — the same pattern as `mcp.json` today) declaring: Volces + LiteLLM llm adapters, `dsh-mcp-client` servers (sourced from `mcp.json` + DB + OpenConnector `/mcp`), `dsh-tool-bash`/`dsh-tool-fs`, and skill paths. **server.js does not re-implement tool or MCP wiring in JavaScript** — it only writes the profile and lets dsh load the plugins. This is where the code deletion happens.

### D4. Host-side config sources unchanged

`mcp.json` + the SQLite MCP-config table + OpenConnector `/mcp` URL + `agents.json` + `AGENTS_CONFIG_URL` are still read by host modules; their *output* feeds the dsh profile instead of being consumed by `mcp-bridge.js`/the pi loader. This keeps `db.js`, `catalog.js`, and `open-connector.js` untouched and means the existing management endpoints (runtime MCP add/remove, catalog refresh) keep working — they regenerate the profile and signal dsh to reload.

### D5. Model list flows from dsh through the bridge

`EXPOSED_PROVIDERS` logic is re-sourced: the bridge asks dsh for its model list (via a JSON-RPC `listModels`-equivalent) and `server.js` surfaces that through the existing `list_models`/`set_model`/`current_model`/`model_changed` messages. `set_model` becomes a JSON-RPC request to dsh; the streaming-reject guard stays host-side (checked before forwarding). No `ModelRegistry` import.

### D6. Skills via dsh skill plugin, `/skill:` expansion preserved

The `/skill:<name> <args>` parsing + `skill_use` WS broadcast + manual-expansion fallback stays in `server.js` (it's host protocol behavior, not agent internals). The *loading* of skill bodies moves from the pi `additionalSkillPaths` resource loader to a dsh skill plugin/profile entry. `list_skills` is served from the same skill directory.

### D7. Event-mapping table (the contract inside the seam)

| dsh notification | → WS event | Notes |
|---|---|---|
| `assistant/text` delta | `text` (delta) | exactly-once-per-turn preserved |
| `tool/*` start/update/end | `tool_start`/`tool_update`/`tool_end` | `name`,`args`,`result`,`isError` mapped |
| turn complete (`session.status`) | `done` | emitted once; guard reset |
| dsh error / child crash mid-turn | `error` then `done` | streaming guard reset on catch path |
| `subagent.*` | (v1: ignored / forwarded as-is) | ceiling documented |

## Risks / Trade-offs

- **[dsh is developer-preview, may ship breaking changes]** → Mitigation: the bridge isolates the protocol; a dsh upgrade touches only `dsh-bridge.js`'s notification map + request methods. Pin a dsh version; test against it before bumping.
- **[Subprocess IPC adds latency vs in-process SDK]** → Mitigation: stdio JSONL is the same transport `fd-pi-bridge` already uses at scale; per-turn overhead is dominated by LLM latency. No backpressure handling in v1 (matches `fd-pi-bridge`); add if throughput ever matters.
- **[Notification method/field names are inferred from dsh docs, may be incomplete]** → Mitigation: phase the event map — implement `text`/`done`/`error`/`tool_*` first (the contract the frontend depends on), log unmapped notifications, iterate against a live dsh runtime.
- **[Rollback surface]** → Mitigation: keep pi imports + `mcp-bridge.js` behind a feature flag (`AGENT_RUNTIME=pi|dsh`, default `dsh` once green) until the change is archived; deletion is the *last* task, not the first.
- **[Profile-generation drift]** → Mitigation: profile is generated from the same env/DB sources the host already reads; a unit check (does the profile contain every `mcp.json` server?) guards it.

## Migration Plan

Phased so the system stays green at every step — each phase ends with a working `npm start`.

1. **Bridge skeleton** — `dsh-bridge.js` spawns dsh, `initialize` handshake, ping. `server.js` wires it behind `AGENT_RUNTIME=dsh`; pi path still the default. Chat works end-to-end on a trivial prompt.
2. **Event translation** — map `text`/`done`/`error`/`tool_*` notifications → WS events. Streaming guard + `done`-exactly-once preserved.
3. **LLM adapters** — Volces + LiteLLM as dsh llm adapters in the profile; model list flows through the bridge; `set_model` becomes a bridge call.
4. **MCP + tools via plugins** — generate the dsh profile's `dsh-mcp-client` servers (from `mcp.json` + DB + OC `/mcp`) and `dsh-tool-bash`/`dsh-tool-fs`; delete `mcp-bridge.js` and tool shims.
5. **Skills** — move skill loading to a dsh skill plugin/profile entry; keep `/skill:` parse + `skill_use` host-side.
6. **Catalog `agent-local`** — repoint the `agent-local` catalog entry at the dsh-backed session; `agent-remote`/`app` untouched.
7. **Flip default + cleanup** — `AGENT_RUNTIME=dsh` default; remove pi imports + `pi-provider-litellm` from `package.json` only after the dsh path is green in `npm start` + e2e.

Rollback at any phase: set `AGENT_RUNTIME=pi` (phases 1–6) or `git revert` the cleanup commit (phase 7).

## Open Questions

- Exact dsh JSON-RPC method names for `prompt` / `setModel` / `listModels` — confirm against a live `dsh` runtime before phase 1 (the `@deepseek-ai/dsh-sdk-client` README lists `prompt()` returning a message id; the raw method names need verifying). Decisions D2/D7 are stable regardless of the exact names.
- Whether dsh exposes a "reload profile" RPC (for runtime MCP add/remove) or requires a child restart — affects how the existing management endpoints signal dsh. If no reload RPC, fall back to restart-with-backoff (the child already supports that).
- dsh skill plugin contract — is it a profile `skillPaths` entry (mirror of pi's `additionalSkillPaths`) or a dedicated plugin? Confirm before phase 5; D6 (host keeps `/skill:` parsing) holds either way.
