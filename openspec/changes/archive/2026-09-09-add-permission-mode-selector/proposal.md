# add-permission-mode-selector

## Why

The dsh runtime already composes `dsh-permission-presets` with the same three
permission modes the harness product line exposes (`read-only` /
`workspace-write` / `danger-full-access`), but the platform pins the mode at
spawn time via `DSH_PERMISSION_MODE` and offers no way to see or change it. A
user cannot inspect which mode a session runs in, tighten it before a risky
task, or relax it without restarting the server. The capability seam is fully
present in the runtime (`PermissionPresetService.set` switches a live session
durably); only the bridge and UI are missing.

## What Changes

- The local bridge plugin (introduced by `add-dsh-agent-presets`, which lands
  first) gains two JSON-RPC methods: `permissions/list` (preset roster with
  client labels + the session's effective preset) and `permissions/set`
  (live, in-session switch via `PermissionPresetService.set` — no child
  restart, unlike preset/model/workspace switches).
- WS additions mirroring the preset contract: `list_permissions` /
  `set_permission` (client→server), `permissions` roster push and
  `current_permission` (server→client). `set_permission` is rejected while
  streaming (same guard as `set_model`).
- New UI control in the composer control strip (`StripMenu` chip, same shell
  as effort/model): shows the effective preset, lists roster options with
  name + description, switches live. Renders store state only — after a
  child restart the chip reflects the deployment default again (safe reset).
- The deployment default stays `DSH_PERMISSION_MODE` (today `workspace-write`
  → approval `ask`); v1 does not add a Settings surface for changing it.
- Out of scope (follow-up change): an interactive approval answerer. Today
  approval asks under `ask` policy fail closed in the headless bridge
  (`unavailable` → the tool call is rejected); this change makes the mode
  visible and switchable but does not add a prompt UI.

## Capabilities

### New Capabilities
- `permission-mode-selection`: selecting which permission preset (sandbox
  mode + approval policy bundle) the current chat session runs under — the
  control-strip selector, the WS contract, the live-switch rule, and the
  restart-resets-to-default behavior.

### Modified Capabilities
- `dsh-runtime-bridge`: the bridge plugin's JSON-RPC surface gains
  `permissions/list` and `permissions/set`, and the platform translates the
  dsh permission/preset session events into WebSocket broadcasts.

## Impact

- `dsh-profile.js` / generated profile patch: the `sdk-jsonrpc-server` row
  (already replaced by the presets bridge) serves the two new methods — no
  new plugin row, no new runtime dependency (`dsh-permission-presets` is
  already composed).
- `server/dsh-bridge` callers (`server/agent-session.js`, `server/ws.js`):
  two new WS message handlers + roster cache per child generation.
- `web/`: one new `StripMenu` control in `ControlStrip`, store fields
  (`permissionOptions`, `currentPermission`), i18n entries in five locales.
- No dsh SDK/protocol package changes; everything rides the subclassed
  server's `handleRequest` dispatch.
