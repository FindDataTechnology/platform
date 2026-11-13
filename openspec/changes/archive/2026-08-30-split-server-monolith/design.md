## Context

`server.js` currently mixes nine concerns: config parsing, express app + WS server construction, forward-auth gating, slash-command/skill expansion, dsh bridge lifecycle + event translation, agent/session/model state machine, ~70 REST routes, two reverse-proxy builders (OpenConnector web + external service), and the boot/shutdown orchestration. All cross-cutting state lives in module scope (e.g. `session`, `dshBridge`, `clients`, `dshToolNames`, `streamedThisTurn`, `declaredModels`), which is why nothing could be extracted before: every function reads/writes that shared scope. Gates now exist (change `add-ci-quality-gates`): lint, typecheck, 30 unit tests, 96 e2e `fast` tests covering every route group and WS command.

## Goals / Non-Goals

**Goals:**
- `server.js` ≤ ~350 lines: config, app/ws construction, module registration, boot + shutdown.
- Every extracted module testable in isolation via an injected context (no imports of `server.js`).
- Zero behavior change: identical routes/paths/status codes/WS messages/boot order/log strings (cosmetic prefix changes allowed only if a test doesn't assert them — assume one does).
- Each extraction lands as an independently green commit (move-only, verified by e2e subset) so review is diffable and bisection works.

**Non-Goals:**
- No renaming of routes, no WS protocol changes, no boot reordering (that's `optimize-hot-paths`), no touching store/bridge module internals (that's `unify-persistence`), no TypeScript migration, no test-framework additions beyond what exists.

## Decisions

**D1 — Single mutable context object (`server/context.js`), not per-module singletons or an event bus.** Today's semantics are shared mutable state read/written from handlers (e.g. `handleDshEvent` mutates `dshToolNames` which WS handlers read; `finishTurn` resets flags WS checks). An event bus would change timing semantics; singletons would re-create the import tangle. The context is a plain object created in the composition root:

```js
// server/context.js — factory, no side effects
export function createAppContext() {
  return {
    app, server, wss,              // constructed in server.js, injected
    clients: new Set(),
    session: null,                 // { dshBridge, sessionId }
    declaredModels: [],
    streamedThisTurn: false,
    dshToolNames: new Map(),
    dshTurnError: null,
    // bound helpers that need the context:
    broadcast(data) { ... },
    finishTurn() { ... },
    throttleDashboardUpdate() { ... },
  };
}
```
Modules receive `ctx` as their first parameter and close over nothing global. Alternative rejected: passing 6+ individual refs per module — parameter lists churn on every extraction.

**D2 — Route modules export a `register(ctx)` function; `server.js` calls them in the exact current registration order.** Registration order is observable (e.g. static + SPA fallback must stay last at `server.js:1260-1266`; multer/auth/json middleware first at :97-110). Each `server/routes/*.js` file:

```js
export function registerDocumentRoutes(ctx) {
  const { app, documents, collections } = ctx;
  app.post("/api/documents", ctx.upload.single("file"), async (req, res) => { ... });
  ...
}
```
`ctx` also carries the service singletons (`documents`, `collections`, `chatHistory`, `cron`, `extensionStore`, `openConnector`, `catalog`, `db`, `migrate`) so modules import only types they construct themselves. Alternative rejected: express `Router()` per module — equivalent but hides the middleware-ordering coupling that currently exists (auth middleware vs route registration interleaving); plain functions on `ctx.app` mirror the current code most faithfully for a move-only change.

**D3 — dsh event translation becomes `server/dsh-events.js` with `attachDshEvents(ctx)`.** `handleDshEvent` (server.js:494-583) + `finishTurn` (184-195) + the dashboard throttle move together; they share `ctx.streamedThisTurn`/`ctx.dshToolNames`/`ctx.dshTurnError`. The bridge notification pump calls `ctx.handleDshEvent(notif)` — injected at `initDshAgent` time exactly as today (server.js:407-411).

**D4 — WS layer becomes `server/ws.js` with `attachWebSocket(ctx)`.** Owns `wss.on("connection")` + upgrade gating (server.js:85-93) + the 15-case message switch (840-1114). Cron/session/chat command cases stay in one switch — splitting the switch by domain would scatter `switchAgentTo`/model state coupling; one file at ~350 lines is acceptable and keeps the diff a pure move.

**D5 — `server/agent-session.js` holds the state machine.** `createNewSession`, `switchToSession`, `getAvailableModels`, `refreshDshModels`, `switchModelTo`, `switchableAgents`, `switchAgentTo`, `streamRemoteChat`, `handleModelCommand`, `startNewSession`, `handleNewCommand` (585-800). These mutate `ctx.session` and broadcast; they're the only writers of `ctx.session` besides `ws.js`.

**D6 — Extract in dependency order, one commit per step, e2e-verified.** Order (leaf → root): 1) `auth.js`, 2) `skills.js` (pure helpers, `getFileSkills` gains an mtime cache ONLY if trivially safe — otherwise cache is deferred to `optimize-hot-paths`; default: defer), 3) `routes/*` (misc, documents, chat-history, extensions, llm, openconnector), 4) `dsh-events.js`, 5) `agent-session.js`, 6) `ws.js`, 7) final: context extraction completes, `server.js` becomes composition root. Each step: move code, wire `ctx`, run `npm run test:e2e` (fast), commit.

**D7 — Dynamic-import sites move with their consumers.** `llm-providers.js` and `dsh-profile.js` are dynamically imported inside route handlers today (server.js:394, 330-331, 1365) to avoid a startup cost/order dependency. Route modules keep the same dynamic imports; do not "clean up" to static imports (would change boot behavior — `optimize-hot-paths` owns import strategy deliberately).

## Risks / Trade-offs

- [Hidden temporal coupling broken by extraction (init order matters, e.g. `initDshAgent` before `migrate`, `documents.initStore` before legacy migration)] → Boot sequence stays byte-identical in `server.js`; only function bodies move. Add a one-time boot-order assertion comment block referencing the migrate.js sequencing note.
- [`this`-free context mutation across files invites accidental cycles (routes importing ws importing routes)] → Rule enforced in review + lint import boundaries if Biome supports it: `server/*` may import `server/context.js` types but never each other's registration entry points; only `server.js` imports registrars. `dsh-events`/`agent-session`/`ws` may not be imported by route modules (they go through `ctx`).
- [96-test e2e suite is slow to run per extraction step (~minutes)] → Cheaper guard per step: targeted spec (e.g. `extensions.spec.js` for the extensions routes) + full `fast` suite at each milestone (after step 3, 6, 7). CI runs the full suite on the PR regardless.
- [Unit tests reach into `server.js`? Check: none do (they test chat-history/llm-providers/store modules directly)] → Verified during exploration; no unit test changes expected.
- [Two files named like existing modules (`server/routes/chat-history.js` vs root `chat-history.js`) confuse imports] → Accepted; root modules keep their names (they're the service layer), route files live under `server/routes/`. Imports read `../chat-history.js` vs `./routes/chat-history.js` — distinct enough; flagged in PR description.

## Migration Plan

Pure refactor on one branch, sequential commits as in D6; no data migrations, no config, no release coordination. Rollback = revert branch. Deploys unaffected (`node server.js` entrypoint unchanged, supervisor webServer config unchanged).

## Open Questions

- None blocking. Optional follow-up noted for `optimize-hot-paths`: `getFileSkills` sync-fs caching.
