# add-dsh-agent-presets

## Why

dsh ships four agent modes — 标准 / PTC / 极简 / 创造 (`standard` / `code` /
`minimal` / `cordis`, metadata in each preset dir's `preset.yml`) — and the
harness supports a user-authorable preset root at `~/.dsh/.agent-presets`.
The platform profile (`dsh-base` + `sdk-jsonrpc-server`) composes **none** of
it: `dsh-agent-presets` is not in the bundle, and the JSON-RPC SDK server has
zero preset awareness (the word "preset" does not appear in its source). Users
therefore get the host composition only and cannot pick a mode.

## What Changes

- The generated platform dsh profile gains two plugin rows in its patch:
  `@deepseek-ai/dsh-agent-presets` (roster service configured with the shipped
  preset root + the default user root) and a small **local bridge plugin**
  authored in this repo that subclasses the exported
  `HarnessSdkJsonRpcServer`:
  - `initialize` accepts `agentPreset` (the deployment-selected mode);
  - session creation passes an unpublished-agent `setup(agentCtx)` hook that
    calls `agentPresets.mount(agentCtx, id)` — the one supported call site, so
    a broken/unknown preset fails session creation before publication;
  - a new `presets/list` JSON-RPC method returns the roster (id, display name,
    description, trust, broken) for the UI.
- `dsh-profile.js` generates the bridge plugin file + the patch overlay (same
  mechanism as the existing `mcp.patch.yml` / `skills.patch.yml`) and pins
  `@deepseek-ai/dsh-agent-presets` in `dsh-profile-template/package.json` at
  the same rc version as the other dsh peers.
- Mode selection rides the existing **restart path** (same as model/workspace
  switching): a selected mode is passed to `dshBridge.restart({ agentPreset })`
  → fresh child `initialize`, and applies to the next session. A running
  session keeps the mode it started with — dsh refuses to recompose a session
  that has produced turns (`agent-preset-locked`), so the UI only offers the
  picker on the welcome / blank state and shows a read-only label elsewhere.
- New UI surfaces (`web/`): a mode picker on the welcome state (cards/chips
  with name + description for the four shipped modes plus any user presets the
  roster reports), and a read-only current-mode label in the chat header.
  Shipped modes display localized names; user presets display their
  `preset.yml` name/description verbatim.
- WS additions: `list_presets` (client→server), `presets` roster push and
  `current_preset` (server→client), `set_preset` (gated exactly like
  `set_model`: rejected while streaming, error sent only to the requesting
  client).
- v1 does NOT include preset authoring (copy/delete/open-directory). User
  presets dropped into `~/.dsh/.agent-presets` are listed and selectable
  immediately; management UI is a later change.

## Capabilities

### New Capabilities
- `agent-preset-selection`: selecting which dsh agent composition (mode) new
  sessions run, from the roster the dsh runtime composes; the welcome-state
  picker, the read-only in-session label, the WS contract, and the
  blank-session-only switching rule.

### Modified Capabilities
- `dsh-runtime-bridge`: the spawned profile now composes the agent-presets
  roster plugin and the preset-bridge SDK server; `initialize` carries the
  selected preset; restart gains an `agentPreset` option.

## Impact

- `dsh-profile.js` (profile generation), `dsh-profile-template/package.json`
  (pinned peer), one new small bridge plugin source file copied into the
  generated profile.
- `dsh-bridge.js` (`restart({ agentPreset })`, `listPresets()` RPC).
- `server/agent-session.js` + `server/ws.js` (preset WS handlers + streaming
  guard), `server/context.js` (current-preset state).
- `web/src/`: welcome-state picker component, chat-header label, WS types,
  store fields, i18n bundles (en + zh-CN), e2e coverage.
- New dependency: `@deepseek-ai/dsh-agent-presets` (profile-time, pinned
  `0.1.1-rc.2`, already installed transitively in the global dsh package; the
  profile pin makes it resolvable inside the generated profile).
- Runtime behavior change: sessions after this change mount the `standard`
  composition instead of the bare host composition. This is additive
  (standard is "the full coding agent" the product already assumes), but it
  changes which plugins the dsh child loads on first boot after upgrade.
