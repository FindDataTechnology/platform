# Design — thinking-level-selection

## D1. The settings file IS the transport (no new RPC)

dsh's SDK surface (`dsh-sdk-protocol` `InitializeParams`) is `cwd/provider/model/maxTokens` only; there is no `setModel`, no per-prompt config, no effort RPC. But `dsh-llm-pi-ai` reads the effort from its own profile in `$DSH_HOME/settings.yaml`:

- provider-level `reasoning: <level>` — the default for every model on that route
- per-model `reasoningEfforts: { <level>: <wire-value>|null, ... }` — the offered set (`false` = non-reasoning)
- resolution: `resolveReasoningLevel(model, effort)` throws `UNSUPPORTED_REASONING_EFFORT` if the explicit level isn't in the model's supported set

`dsh-profile.js::writeLlmProfile()` already owns that file section. Therefore: **effort switch = mutate the generated profile + `dshBridge.restart()`** — byte-identical mechanics to model switching (server.js already rejects both while streaming). The bridge needs zero changes.

Consequence: effort is per-provider (not per-model) at the dsh layer. The UI can still present it per-model, but the host writes the provider-level `reasoning` and the offered set is intersected with the selected model's declared `reasoningEfforts`. When the user switches model, the UI re-derives the offered list; an incompatible persisted effort falls back to provider default with a toast.

## D2. What we declare for Volces / user providers

We generate the settings.yaml, so offered levels are ours to declare — the gateway never sees a level we didn't map. Start minimal:

- Volces route: declare `reasoningEfforts` only for models we know support the OpenAI `reasoning_effort` wire field (deepseek-v4 family). Wire value = the level string itself (`{ low: "low", medium: "medium", high: "high" }`); other Volces models (glm/kimi/qwen/…) declare `false` in v1 unless verified — wrong `false` just hides a control, wrong map = dispatch error.
- User providers (Models page): an optional free-text list of levels stored in the provider row; written verbatim as `reasoningEfforts` with identity wire values. Empty = omitted (provider default).

## D3. Persistence & protocol shape

- Selected effort: one row in the existing SQLite preferences store (`key = 'llm.effort.<provider>'`). Read at boot by `writeLlmProfile()` so the generated profile carries it (survives host restarts); updated on `set_effort`.
- `models` payload per model: `reasoningEfforts?: string[]` (absent/empty = no control for that model).
- New WS messages:
  - client→server `set_effort { effort }` → validates against current model's list, rejects while streaming, writes settings + prefs, restarts bridge, broadcasts `effort_changed { effort }`.
  - server→client `current_effort { effort }` on connect (piggybacks the existing ready-sync payload).

## D4. UI: one selector, two axes

The `/models` page already owns default-model selection. Extend its per-model row/detail with an effort picker (Default + declared levels); the Sidebar chat chip displays `Model · high` when a non-default effort is active and navigates to the same page. No new route. Locale strings for all five languages (check-locales gate).

## Alternatives rejected

- **Per-prompt effort via content-block metadata** — no such channel in `SessionPromptParams`; would require upstream dsh change.
- **A second dsh child per effort** — doubles memory for a knob.
- **Persisting effort in settings.yaml only** — `writeLlmProfile()` regenerates the section on every boot, so host-side persistence (prefs DB) must be the source of truth and the yaml the projection.
