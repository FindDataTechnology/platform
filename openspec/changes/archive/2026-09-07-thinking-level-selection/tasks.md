## 1. Profile generation (dsh-profile.js)

- [x] 1.1 Extend `VOLCES_MODELS` entries (or a parallel map) with `reasoningEfforts` for models known to support `reasoning_effort` on the gateway (deepseek-v4 family: identity-mapped `low/medium/high`); non-reasoning models declare `false`; unverified models omit the field (provider default)
- [x] 1.2 `buildLlmProfile()` accepts the persisted effort (from prefs) and writes provider-level `reasoning: <level>` into the generated `llm-pi-ai` section when set; exported `writeReasoningLevel(level)` (or extension of the existing write path) updates the section in place, atomic temp+rename, preserving other sections
- [x] 1.3 User-provider rows (llm-providers.js) gain an optional `reasoningEfforts: string[]` field, written verbatim with identity wire values; Models-page provider form exposes it as an optional comma-separated list
- [x] 1.4 Self-check `main` block: generate a profile with effort=high and assert the yaml round-trips (`llm-pi-ai.providers.volces.reasoning === "high"`, model entry has `reasoningEfforts`)

## 2. Persistence + server wiring

- [x] 2.1 Preferences store: get/set `llm.effort.<provider>`; read at boot feeds `writeLlmProfile()`; `set_effort` updates it
- [x] 2.2 `list_models`/`models` payload: per-model `reasoningEfforts: string[]` (absent when none); ready-sync + `current_model` payload carries `effort`
- [x] 2.3 New WS command `set_effort { effort }`: validate against current model's declared list (403-style error message on unsupported), reject while `ctx.isStreaming`, write settings + prefs, `dshBridge.restart({ provider, model })`, broadcast `effort_changed { effort }`
- [x] 2.4 Model switch re-derives effort validity: if persisted effort unsupported by the new model, drop to provider default and include `effort` in the `model_changed` payload

## 3. UI

- [x] 3.1 ModelsPage: per-model effort picker (Default + declared levels) wired to `set_effort`; disabled while streaming; hidden for models without declared efforts
- [x] 3.2 Sidebar chat chip shows `Model · effort` when non-default effort active
- [x] 3.3 Chat store + WS types for `set_effort`/`effort_changed`/`current_effort` and the extended `models`/`model_changed` payloads
- [x] 3.4 Locale strings (en, zh-CN, es, fr, ja) — `npm run check:locales` green

## 4. Verification

- [x] 4.1 E2E (fast project): selector shows efforts for a declared model, `set_effort` round-trips to `effort_changed`, control hidden for a non-reasoning model
- [ ] 4.2 Manual: with a real Volces key, send one prompt at `high` and confirm the request carries `reasoning_effort` (server debug log or gateway-side), thinking deltas render in the existing ThinkingBlock
