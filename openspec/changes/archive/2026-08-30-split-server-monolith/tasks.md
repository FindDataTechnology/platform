## 1. Scaffolding

- [x] 1.1 Create `server/context.js` with `createAppContext()` holding the current module-scoped state (clients, session, declaredModels, streamedThisTurn, dshToolNames, dshTurnError) and bound helpers (broadcast, throttleDashboardUpdate, finishTurn); server.js constructs it and aliases module-scope names to ctx fields (temporary bridge so intermediate commits stay green)
- [x] 1.2 Add a boot-order comment block in server.js documenting the init-sequence invariants (db → documents store → dsh agent → legacy migrations → catalog → cron → listen)

## 2. Leaf extractions (no cross-deps)

- [x] 2.1 Extract `server/auth.js` (userFromHeaders, forward-auth middleware, requireAdmin); run targeted e2e `auth-catalog.spec.js`, commit
- [x] 2.2 Extract `server/skills.js` (parseCommand, expandSkillContent, getFileSkills — behavior-identical, no caching changes); run chat-command/skills specs, commit

## 3. Route extractions (order mirrors current registration)

- [x] 3.1 Extract `server/routes/misc.js` (/api/auth/me, /api/catalog*, /api/apps/:id/connect, /api/config, /api/supervisor/status, /api/preferences, static + SPA fallback wiring) — fallback registration must remain last; run nav/app specs, commit
- [x] 3.2 Extract `server/routes/documents.js` (/api/documents*, /api/collections*); run documents/collections specs, commit
- [x] 3.3 Extract `server/routes/chat-history.js` (/api/chat-history/*); run chat-history specs, commit
- [x] 3.4 Extract `server/routes/extensions.js` (/api/extensions/*); run extensions.spec.js (20 tests), commit
- [x] 3.5 Extract `server/routes/llm.js` (/api/llm/*, /api/models/refresh, withLlmWriteLock, reloadLlmProviders — keep the dynamic import of llm-providers.js/dsh-profile.js); run llm-models + model-selection specs, commit
- [x] 3.6 Extract `server/routes/openconnector.js` (/api/openconnector/*, createWebProxy, buildExternalServiceProxy, runOpenConnector); run embedded-views + OC specs, commit
- [x] 3.7 Milestone: run full `npm run test:e2e` (fast) — all green before proceeding

## 4. State-machine and WS extractions

- [x] 4.1 Extract `server/dsh-events.js` (handleDshEvent, finishTurn internals, dashboard throttle; dsh pump wires ctx.handleDshEvent); run dashboard + chat-streaming specs, commit
- [x] 4.2 Extract `server/agent-session.js` (createNewSession, switchToSession, getAvailableModels, refreshDshModels, switchModelTo, switchableAgents, switchAgentTo, streamRemoteChat, handleModelCommand, startNewSession, handleNewCommand); run model-selection + agents-tabs specs, commit
- [x] 4.3 Extract `server/ws.js` (wss connection handler, upgrade gate, 15-case message switch); run full `npm run test:e2e` (fast), commit

## 5. Composition root + guardrails

- [x] 5.1 Finish `server.js` as composition root (≤ ~350 lines): config parsing, app/server/wss construction, ctx creation, registrar calls in current registration order, boot sequence, shutdown handler; remove the temporary aliasing bridge from 1.1
- [x] 5.2 Verify no `server/*` module imports another module's registration entrypoint or root server.js (import-boundary pass; add Biome rule or manual grep documented in PR)
- [x] 5.3 Full gate run (e2e requires web:build:e2e dist — plain web:build lacks the test seam): `npm run lint && npm --prefix web run typecheck && npm run test:unit && npm run check:locales && npm run web:build && npm run test:e2e` — all green
- [x] 5.4 Confirm entrypoints unchanged: `node server.js` boots; `playwright.config.js` webServer untouched; supervisor/lifecycle.js untouched
