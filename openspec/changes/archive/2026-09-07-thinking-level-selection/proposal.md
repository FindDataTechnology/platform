## Why

The chat UI offers model selection (Sidebar chip → `/models` page) but no thinking/reasoning-effort control, even though dsh's LLM stack fully supports one. Verified against the installed runtime: `llm-pi-ai` reads a per-provider `reasoning` level from `$DSH_HOME/settings.yaml` (`off|minimal|low|medium|high|xhigh|max`, see `THINKING_LEVELS` in `dsh-llm-pi-ai/lib/index.js`), and each `models[]` entry may declare a `reasoningEfforts` map (level → wire value; `false` = non-reasoning model). `dsh-llm` validates the effort at dispatch and throws `UNSUPPORTED_REASONING_EFFORT` on a mismatch — so the host must only offer levels the model actually supports. The `initialize` RPC carries no effort field and there is no per-prompt config RPC, so the only host-writable channel is the settings file our own `dsh-profile.js` already generates — meaning effort switching rides the exact same restart path as model switching (`dshBridge.restart()`), with dsh resuming the session from disk.

Today that settings.yaml is rewritten from scratch on boot (`writeLlmProfile()` regenerates the `llm-pi-ai` section from env + user providers), so there is also no place a chosen effort survives a restart. This change adds: effort metadata in the generated profiles, a persisted host-side selection, a `set_effort` WS command using the restart path, and a UI that puts model and effort in ONE selector.

## What Changes

- `dsh-profile.js`: `buildLlmProfile()` gains an optional per-provider `reasoning` field (and per-model `reasoningEfforts` where the provider documents them) written into the generated `llm-pi-ai` section; a new exported `writeReasoningLevel(provider, level)` (or fold into the existing write) updates the persisted profile so the choice survives host restarts. Volces models that are known non-reasoning declare `reasoningEfforts: false`.
- New persistence: the selected effort is stored in the existing SQLite preferences store (same mechanism as the default model), keyed by provider.
- `server.js`: new WS command `set_effort` — validates the level against the current model's declared efforts, rejects while `ctx.isStreaming`, writes the settings.yaml update, then `dshBridge.restart({ provider, model })` (the profile re-read supplies the effort; no bridge signature change needed). Broadcasts `effort_changed` (and re-broadcasts `current_effort` on connect alongside `current_model`).
- `list_models` response and `models` payload gain an optional `reasoningEfforts: string[]` per model (empty/omitted = provider-default only); `current_model` payload gains `effort`.
- Web `/models` page: the model selector becomes a two-axis control — pick model, then pick effort from the model's supported levels (including "Default" when none declared). The Sidebar model chip shows `model · effort` when a non-default effort is active. `model-selection` WS contract gains the two message types.
- Graceful degradation preserved: no declared efforts → control hidden, no settings field written, chat unaffected.

## Capabilities

### Modified Capabilities
- `model-selection`: adds effort as a selectable axis alongside model; new `set_effort`/`effort_changed`/`current_effort` messages; `models` payload carries per-model reasoning metadata.

## Impact

- **Backend**: `dsh-profile.js` (profile generation + reasoning write), `server.js` (WS command, broadcast, restart wiring), SQLite preferences (effort column/row).
- **Frontend**: `web/src/pages/ModelsPage.tsx`, `web/src/components/Sidebar.tsx`, chat store, WS types, locales (`en`,`zh-CN`,`es`,`fr`,`ja` — `check-locales` gate).
- **No new dependencies.** No changes to `dsh-bridge.js` (restart already parameterless w.r.t. effort — the settings file is the transport).
- **Known ceiling (ponytail)**: switching effort restarts the dsh child (drops in-memory state; session resumes from disk) — same accepted cost as model switching. Per-message effort override would need an upstream dsh RPC; out of scope.
- **Risk**: `UNSUPPORTED_REASONING_EFFORT` at dispatch if the host offers a level the gateway rejects — mitigated by deriving offered levels only from what we declare in settings.yaml (we control both sides), and validating `set_effort` against that list.
