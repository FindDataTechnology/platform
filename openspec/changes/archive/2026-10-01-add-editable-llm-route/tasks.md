# Tasks: add-editable-llm-route

## 1. Override store core (llm-providers.js)

- [x] 1.1 Add `volcesOverride` doc handling to the store (`getVolcesOverride` / `setVolcesOverride` / `clearVolcesOverride`) through the existing write chain + write lock, shape `{ baseUrl?, models?, discovery?, updatedAt }`. Verify with unit tests: absent key reads null, write→read round-trip, and a concurrent provider mutation is unaffected.
- [x] 1.2 Narrow the reserved gate: `updateProvider("volces", body)` accepts exactly `{ baseUrl?, models? }` (models through the existing array validator: unique non-empty ids, positive-int `contextWindow`/`maxTokens`), persists into the override, and still rejects name/type/apiKey mutations and deletion with `invalid: reserved provider id`. Verify with unit tests covering the accepted shape, each rejected field, and that `deleteProvider("volces")` still throws.
- [x] 1.3 Replace the reserved dry-run branch in `syncProvider` with the user-provider merge path targeting `volcesOverride.models`/`discovery` (serving-only append with family metadata, no-evict, family-rank order, `syncInFlight` + write lock unchanged, reload invoked). Verify with unit tests against a stubbed gateway: serving ids merge into the override, non-serving existing ids survive, `dryRun` no longer appears in the result.

## 2. Profile projection + API surface

- [x] 2.1 `dsh-profile.js` volces route: roster `override.models ?? VOLCES_MODELS`, base URL `override.baseUrl || env || baked default`, read via the existing lazy `import("./llm-providers.js")`. Verify with unit tests: with an override the projected settings.yaml carries the override roster/URL; without one the projection is byte-identical to today's (existing dsh-profile tests stay green).
- [x] 2.2 `GET /api/llm/providers` synthesizes the reserved record from effective values and adds `override: { active, baseUrl?, rosterSize }` (no key material). Verify with a route unit test: no override → `active: false` + env URL; with override → effective URL + `active: true`.

## 3. Default-lane guard

- [x] 3.1 Implement `server/llm-guard.js` `guardDefaultLane(ctx, { reason })`: one 1-token completion against the default's effective route (bounded timeout), sync-taxonomy classification; definitive dark → switch default to the first `serving` model by last-sync discovery in `ctx.dshModels` order, `setDefault` + `ctx.defaultModel` update + `model_fallback { from, to, reason }` broadcast; network/timeout → keep default silently; no serving known → keep default, log + status note. Verify with unit tests on a stubbed fetch: `model_not_found` falls back, timeout does not, no-serving keeps the default.
- [x] 3.2 Wire the three triggers: boot (inside the `server.js:449-465` default-resolution block, before the initialize handshake completes), after `syncProvider` returns in the sync route, and after `PUT /api/llm/default` applies. Verify with a boot-path unit test (dark default → session starts on the fallback, `current_model` names it) and a route test for the two runtime triggers broadcasting `model_fallback`.

## 4. Models page UI

- [x] 4.1 `ModelListEditor`: add a per-row `contextWindow` input beside `maxTokens` (optional positive int, PUT payload includes it when set) and accept the reserved provider as a valid target. Verify with a component test / e2e that editing both fields round-trips through `PUT /api/llm/providers/:id`.
- [x] 4.2 `ProviderCard` reserved card: render the roster editor, a base-URL override field, an `override active` indicator, and a clear-override action; keep Delete and key editing hidden; drop the dry-run sync label. Add locale strings to all five languages. Verify with e2e: reserved card edits reach the server and the picker updates without a restart; clear restores the env/baked values.
- [x] 4.3 Web client: handle the `model_fallback` WS event with a toast naming the old and new model. Verify with an e2e that forces a dark default against a stubbed gateway and asserts the toast.

## 5. Verification + runbook

- [x] 5.1 Full local gate: unit suites + `npm run test:e2e` (fast) green, biome clean on changed files, `npm run dsh:contracts` green (profile-generation touchpoint). 
- [x] 5.2 DEPLOY.md operator note: the reserved lane is runtime-editable on the Models page (roster/base-URL override, persistent sync, clear-to-rollback); the guard self-heals dark defaults at boot/sync/set — including the 2026-10-01 incident as the motivating example.
