# Tasks

## 1. OpenSpec artifacts

- [x] 1.1 Confirm `proposal.md` describes why the capability is needed, what changes, capabilities, impact, and explicit non-goals; verify with `openspec instructions --change add-sso-user-runtime-bindings proposal --json` and `openspec validate --changes`.
- [x] 1.2 Confirm `design.md` documents context, goals/non-goals, decisions, risks/trade-offs, and migration/rollback; verify the file exists and contains each required section.
- [x] 1.3 Confirm every capability listed in `proposal.md` has a delta spec and every requirement has a `#### Scenario:` with WHEN/THEN; verify with `openspec validate --changes --strict` and `openspec validate --specs --strict`.
- [x] 1.4 Confirm migration and implementation tasks are ordered by dependency and each checkbox states a verification method; verify with `openspec instructions --change add-sso-user-runtime-bindings tasks --json` and `openspec validate --changes`.

## 2. Identity and persistence

- [x] 2.1 Extend `server/auth.js` and `server.js` with an opt-in optional SSO overlay that parses trusted proxy headers only when `AUTH_MODE` is not `forward_auth`; verify auth E2E covers anonymous access, optional SSO identity, and no optional identity from browser-controlled data.
- [x] 2.2 Extend `/api/auth/me` with `ssoConfigured`, `ssoAuthenticated`, `ssoEmail`, and `ssoGroups` while preserving existing forward-auth fields and paths; verify focused HTTP tests for all auth modes.
- [x] 2.3 Add SQLite migration v12 for `user_model_bindings` and `user_mcp_bindings`, including primary keys, enabled check/index, timestamps, transactional application, and idempotence; verify migration tests against fresh and existing databases.
- [x] 2.4 Add database accessors for normalized email-keyed model/MCP binding reads and upserts without altering `user_preferences`; verify unit/integration tests cover two users, case normalization, and database-unavailable behavior.

## 3. Runtime binding coordinator and APIs

- [x] 3.1 Add authenticated `/api/users/me/bindings`, `/api/users/me/model`, `/api/users/me/mcp/:name/enable`, and explicit apply endpoints; verify API tests cover 401, 403/404 where applicable, 503, validation, persistence, and no credential/config leakage.
- [x] 3.2 Implement shared-runtime profile composition and idle/pending application for model and MCP changes; verify tests cover idle switch, streaming deferral, retry after completion, failed application rollback, and no interruption of an in-flight response.
- [x] 3.3 Integrate personal MCP overlays into dsh profile patch generation and serialize global/personal MCP mutations through one chain; verify tests confirm global `extension_configs` is unchanged and concurrent mutations produce a valid final patch.
- [x] 3.4 Keep explicit `set_model` and `/model` behavior global and separate from personal binding persistence; verify model-selection E2E confirms selecting a model does not create a personal binding.
- [x] 3.5 Require existing administrator authorization for global MCP mutations when authentication is enabled; verify admin and non-admin HTTP tests and confirm optional SSO identity alone cannot mutate global configuration.

## 4. WebSocket contract

- [x] 4.1 Add identity-aware WebSocket sync and targeted `user_bindings` events without sending personal data to anonymous or other users' sockets; verify WS integration tests inspect payloads for email/config leakage.
- [x] 4.2 Add global `runtime_binding` and `runtime_binding_pending` events with effective model/MCP state and no email; verify all connected clients receive runtime events and the requesting socket receives its private snapshot.
- [x] 4.3 Reconnect the frontend WebSocket after optional SSO login/sign-out so identity remains fixed at upgrade; verify browser E2E observes socket replacement and correct post-login bindings.

## 5. Frontend experience

- [x] 5.1 Extend auth state and account/login surfaces so `AUTH_MODE=none` remains open while optional SSO login, email, and sign-out are visible when configured; verify localized UI E2E in at least the primary locale and locale key coverage for all five bundles.
- [x] 5.2 Add personal model binding state and “save as my model” behavior to the Models page and model-selection/welcome surfaces; verify UI tests distinguish global selection from saved personal binding and show pending state.
- [x] 5.3 Add personal MCP availability controls to installed MCP cards while retaining global add/edit/remove controls and administrator gating; verify UI tests confirm personal toggles do not change the global enabled state.
- [x] 5.4 Render runtime profile and pending states consistently in the welcome, control strip, account, and MCP surfaces; verify browser tests cover idle application, deferred application, failure, and anonymous global state.

## 6. Verification and documentation

- [x] 6.1 Add focused E2E coverage for optional SSO identity, personal model binding, personal MCP overlay, pending application, global configuration immutability, admin authorization, and sign-out without runtime reset; verify the focused suite passes.
- [x] 6.2 Run `npm --prefix web run typecheck`, `npm run web:build`, and the complete fast E2E suite; verify no new failures beyond a documented clean baseline.
- [x] 6.3 Run `openspec validate --changes --strict` and `openspec validate --specs --strict`; verify the change has all proposal-listed capability deltas and no validation errors.
- [x] 6.4 Update deployment/configuration documentation for `SSO_ENABLED`, proxy anonymous-request requirements, trust boundaries, and shared-runtime limitations; verify the documented commands and paths match implementation.
- [x] 6.5 Sync approved delta specs into the main `openspec/specs/` files, archive the completed change, and verify `openspec validate --archived` reports no incomplete tasks.
