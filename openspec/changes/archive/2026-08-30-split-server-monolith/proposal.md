## Why

`server.js` is a 2,224-line monolith holding ~70 HTTP routes, a 15-command WebSocket switch, the dsh event pump, forward-auth, the OpenConnector reverse proxies, and the entire boot/shutdown sequence. Every feature lands in the same file (the `/models` work alone interleaved LLM CRUD, a write lock, and admin gating into it), merge conflicts are structural, and the upcoming performance work (boot reordering, hot-path fixes) would pile more edits onto the same file. Second of four sequenced optimisation changes — it lands after CI gates exist (`add-ci-quality-gates`) so the mechanical move is protected by lint/typecheck/unit/96 e2e tests, and before perf work so those diffs land in small files.

## What Changes

- Decompose `server.js` into focused modules under a new `server/` directory, with `server.js` reduced to a ~300-line composition root (config, app construction, boot sequence, shutdown):
  - `server/context.js` — the shared app-context object replacing module-scoped mutable state (`session`, `dshBridge`, `clients`, `broadcast`, `dshToolNames`, streaming flags, declared models…)
  - `server/auth.js` — forward-auth middleware + `userFromHeaders` + `requireAdmin`
  - `server/dsh-events.js` — `handleDshEvent` translation layer (turn/tool/chunk events) + finish-turn logic
  - `server/agent-session.js` — session create/switch, model list/switch, agent switch, remote-chat streaming
  - `server/ws.js` — WebSocket connection handler and the 15-case message switch (chat, cron, session commands)
  - `server/routes/documents.js` — `/api/documents*` + `/api/collections*`
  - `server/routes/llm.js` — `/api/llm/*`, `/api/models/refresh`, the LLM write lock, provider reload
  - `server/routes/extensions.js` — `/api/extensions/*` (MCP + skills + market)
  - `server/routes/chat-history.js` — `/api/chat-history/*`
  - `server/routes/openconnector.js` — `/api/openconnector/*` + `createWebProxy`/`buildExternalServiceProxy`
  - `server/routes/misc.js` — `/api/auth/me`, `/api/catalog*`, `/api/apps/:id/connect`, `/api/config`, `/api/supervisor/status`, `/api/preferences`, static + SPA fallback
  - `server/skills.js` — skill-file scan/expansion + slash-command parsing (`parseCommand`, `expandSkillContent`, `getFileSkills`)
- **Zero behavior change**: same routes, same WS protocol, same boot order, same logs semantics. Pure code movement plus explicit dependency injection.
- No new dependencies.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `web-chat-server`: adds an explicit external-contract requirement pinning the entrypoint, route surface, WS protocol, and boot-order semantics as invariant during and after the decomposition (all existing requirements continue to hold verbatim).

## Impact

- **Files**: `server.js` (shrinks to composition root), new `server/` tree (~14 files). No changes to `db.js`, `chat-history.js`, `documents.js`, `dsh-bridge.js`, `dsh-profile.js`, `llm-providers.js`, `cron.js`, or any store — their public APIs are consumed unchanged.
- **Import surface**: `scripts/start.js`/supervisor launch `server.js` — unchanged entrypoint; `playwright.config.js` webServer also launches `node server.js` — unchanged.
- **Risk containment**: the e2e `fast` project (96 tests) exercises every route group and WS command; CI from change 1 gates every PR.
- Follow-up changes (`unify-persistence`, `optimize-hot-paths`) then edit small files instead of the monolith.
