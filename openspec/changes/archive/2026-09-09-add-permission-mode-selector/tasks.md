## 1. Bridge plugin (depends on add-dsh-agent-presets landing)

- [x] 1.1 Verify `PresetOption` shape and `PermissionPresetService` access path against the installed `dsh-permission-presets/lib/types/` (optionOf, names, current, set) and record the exact serializer shape in the bridge file header comment
- [x] 1.2 Extend the bridge plugin's `handleRequest` with `permissions/list` returning `{ options, current }` (empty options when the service is absent) and verify via a stdio JSON-RPC probe against a spawned child that the roster matches the composed table
- [x] 1.3 Add `permissions/set` calling `service.set(session, name)` with unknown-name errors surfacing as JSON-RPC errors, and verify the switch appends `permission/preset` session events without a child restart (child pid unchanged)

## 2. Server WS layer

- [x] 2.1 Add roster cache per child generation in the dsh bridge host layer (invalidate on reconnect) and verify the cache refreshes after a `restart`
- [x] 2.2 Add `list_permissions` / `set_permission` WS handlers with the streaming guard (`isStreaming` → error to sender only) and `ctx.ready.dsh` precondition, and verify both via the WS probe harness (`e2e/` probe pattern)
- [x] 2.3 Translate `permission/preset` session events into `permissions` / `current_permission` broadcasts and verify a switch made by one client reaches a second connected client
- [x] 2.4 Broadcast the roster + current on client connect and after each successful switch; verify with a fresh socket connect mid-session

## 3. Web client

- [x] 3.1 Add store fields (`permissionOptions`, `currentPermission`) with reset-on-`pendingConfig` semantics, and verify the store resets on a model-switch restart cycle
- [x] 3.2 Add the `StripMenu` permission control to `ControlStrip` (hidden until roster received; `custom` rendered as non-switchable current; checkmark on current) and verify manually against a running server
- [x] 3.3 Wire `list_permissions` on connect and `set_permission` on pick with the pending/spinner treatment of the other strip controls, and verify the chip never shows optimistic state
- [x] 3.4 Add i18n entries (control label, per-preset label/description for the three shipped presets, custom placeholder) to all five locales and verify no missing-key warnings in the console

## 4. Tests + e2e

- [x] 4.1 Server unit tests: roster cache invalidation, streaming guard, unknown-preset error routing (verify `npm test` passes)
- [x] 4.2 e2e: strip shows `workspace-write` by default → switch to `read-only` → chip updates → model switch → chip returns to default (verify Playwright run passes)
- [x] 4.3 Update `openspec/specs` deltas are already written; run `openspec validate add-permission-mode-selector --strict` and fix any reported issues
