# Proposal: add-sso-user-runtime-bindings

## Why

The application now has an in-application SSO entry, but that identity is not connected to runtime preferences. Anonymous users can use the shared chat, while model and MCP changes are global and immediately affect everyone. Users need a way to sign in optionally, keep their preferred model and MCP availability by SSO email, and have those preferences applied without turning the current single-runtime application into a multi-tenant system.

## What Changes

- Add an optional SSO identity overlay for `AUTH_MODE=none`. Anonymous access remains available; a trusted proxy can attach an existing oauth2-proxy/Logto identity without introducing Platform passwords, cookies, or user accounts.
- Preserve the existing hard `AUTH_MODE=forward_auth` gate and its localhost/firewall trust boundary. Optional SSO identity does not grant administrator privileges.
- Add identity-scoped model bindings and MCP enabled/disabled overlays keyed by normalized SSO email.
- Apply a user's effective model and MCP profile to the shared dsh runtime when it is idle. Do not interrupt an in-flight response; retain a pending profile and report its state when a switch cannot be applied immediately.
- Keep MCP URLs, headers, credentials, and complete configurations under global administration. A personal MCP binding changes only whether an already configured global server is enabled for that user.
- Expose personal binding state and actions in the login/account, model selection, welcome, and installed MCP surfaces. Distinguish personal toggles from global add/edit/remove operations.
- Add identity-aware WebSocket state and targeted binding events while keeping runtime profile changes visible to all connected clients without exposing another user's email.
- Add a database migration and authenticated REST endpoints for reading and saving personal bindings.
- Require administrator authorization for global MCP mutations; personal MCP toggles must not modify the global configuration store.

## Capabilities

### New Capabilities

- `user-runtime-bindings`: Identity-scoped model and MCP preferences, effective runtime profile application, idle/pending switching, and the corresponding API and WebSocket contract.

### Modified Capabilities

- `forward-auth`: Add optional SSO identity introspection in auth-disabled mode while preserving the existing forward-auth gate and trust boundary.
- `model-selection`: Allow a saved personal model binding to determine the effective model for an authenticated user while retaining explicit global model selection behavior.
- `mcp-integration`: Apply a personal enabled/disabled overlay to globally configured MCP servers without copying or changing their configuration.
- `project-database`: Add a migration and persistence model for email-keyed model and MCP bindings separate from global preferences.
- `web-chat-server`: Define shared-runtime profile ownership, idle application, pending behavior, and identity-aware WebSocket synchronization.
- `extension-runtime-management`: Separate personal MCP availability toggles from global MCP mutations and require administrator authorization for global changes.

## Impact

- **Code:** `server/auth.js`, `server/routes/misc.js`, `server/routes/extensions.js`, `server/routes/user-bindings.js`, `server/runtime-bindings.js`, `server.js`, `server/ws.js`, `server/agent-session.js`, `dsh-profile.js`, `db.js`, and the existing auth/model/extensions frontend stores and components.
- **APIs:** Add authenticated `/api/users/me/*` binding endpoints and extend `/api/auth/me` with optional SSO state. Existing global preference and MCP APIs remain global.
- **Database:** Add a transactional migration for `user_model_bindings` and `user_mcp_bindings`; keep `user_preferences` global and unchanged in meaning.
- **WebSocket:** Add targeted personal binding snapshots and global runtime profile/pending events. WebSocket identity remains fixed at upgrade and is never supplied by browser JavaScript.
- **UI:** Keep anonymous use available, add an optional login action, and make personal model/MCP state explicit in the existing surfaces.
- **Deployment:** Optional SSO requires the reverse proxy to allow anonymous requests to reach Platform while injecting identity when an oauth2-proxy cookie is present. A proxy that redirects every anonymous request before Platform remains incompatible with an in-application anonymous login surface.
- **Out of scope:** Local username/password authentication, Platform-owned sessions, per-user MCP credentials, per-user chat/document/session isolation, and multi-tenant runtime isolation.
