# Tasks — add-dsh-agent-presets

## Profile + bridge

- [x] 1. Pin `@deepseek-ai/dsh-agent-presets@0.1.1-rc.2` in
  `dsh-profile-template/package.json` (same rc as the other dsh peers).
- [x] 2. Add the bridge plugin source to the repo
  (`dsh-profile-template/platform-preset-bridge.js`): subclass
  `HarnessSdkJsonRpcServer`; `initialize` stores `params.agentPreset`;
  override `createSession` to call `this.ctx.agents.create(...)` with a
  `setup(agentCtx)` hook that calls `agentPresets.mount(agentCtx, id)`,
  disposing + rethrowing on failure; add `presets/list` in
  `handleRequest` returning serialized roster rows
  (id/name/description/trust/broken).
- [x] 3. Extend `dsh-profile.js`: resolve the shipped preset root via
  `createRequire` → `@deepseek-ai/dsh/package.json` →
  `config/agent-presets`; write the bridge file + a third patch overlay
  (`presets.patch.yml`) with the `agent-presets` row (default `standard`,
  shipped root `trust: system`) and the replaced `sdk-jsonrpc-server` row;
  warn-and-skip when resolution fails; add the `--patch` flag in
  `dsh-bridge.js` spawn args.
- [x] 4. `dsh-bridge.js`: add `agentPreset` to `initialize` params and to
  `restart()` options; add a `listPresets()` JSON-RPC call wrapper cached
  per child generation.

## Server WS + state

- [x] 5. `server/context.js`: add `currentPreset` (initial from persisted
  prefs `agent.preset`, default `standard`) and roster cache.
- [x] 6. `server/agent-session.js`: `switchPresetTo(id)` — validate against
  the roster (unknown/broken rejected, streaming guard), persist pref,
  `dshBridge.restart({ agentPreset: id })`, broadcast `current_preset`.
- [x] 7. `server/ws.js`: handle `list_presets` / `set_preset`; push
  `presets` + `current_preset` on connect and after restart-ready; fetch
  roster through the bridge.
- [x] 8. Record the mounted preset per session (best-effort metadata on
  session creation) so a resumed session's label resolves; blank = default.

## Web UI

- [x] 9. WS types + store: `presets`, `currentPreset`, `pendingConfig`
  already covers the restart window.
- [x] 10. `PresetPicker` component on `ChatWelcome`
  (`data-testid="agent-preset-picker"`): roster cards/menu with name +
  description, broken rows disabled with reason, user rows marked.
- [x] 11. Read-only `agent-preset-label` in `ChatHeader`.
- [x] 12. Localized display names/descriptions for the four shipped ids
  (en + zh-CN i18n bundles); file metadata verbatim for user/unknown rows.

## Verify

- [x] 13. Manual: `npm start`, smoke-test one prompt in each of the four
  modes via the WS probe; confirm `standard` runs after a fresh upgrade.
  (Smoke-covered: WS roster with the shipped four, `set_preset` switch +
  restore round-trips, unknown-id rejection, streaming-guard rejection, one
  real prompt on `standard` (session created + `agent_preset` stamped);
  per-mode LLM round-trips for `code`/`minimal`/`cordis` need a real key.)
- [x] 14. e2e (`e2e/agent-presets.spec.js`, data-testids from the spec):
  picker renders the shipped four on welcome; selecting emits `set_preset`
  and composer blocks while pending; header shows the label in-session;
  streaming-state pick rejected; empty-roster deployment renders nothing.
- [x] 15. Run full fast e2e suite + `npm run web:build`; update
  CLAUDE.md profile-generation notes if the generated-file list changed.
