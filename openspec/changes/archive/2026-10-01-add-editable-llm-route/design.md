# Design: add-editable-llm-route

## Context

The Models page and its API already have everything this change needs except write-access to the reserved route: `llm-providers.js` owns a JSON store (`llm-providers.json`, `{ providers: [...] }`) with an atomic-write chain, a write lock, sync classification, and a family-metadata table; `dsh-profile.js` builds the volces route from the baked `VOLCES_MODELS` constant + `LLM_BASE_URL` env and already lazily imports `llm-providers.js` to merge user providers (cycle-safe pattern in place); `reloadLlmProviders()` in `server/routes/llm.js` applies any store change through `writeLlmProfile()` + Chokidar hot-reload with zero restarts. Boot resolves the default model in `server.js:449-465` (cell binding → persisted Models-page pointer → `DEFAULT_MODEL` env → first declared) before the dsh initialize handshake. What is missing: `RESERVED_IDS` rejects all mutations of `volces`, `syncProvider` short-circuits it into a dry run, and the reserved card's UI hides the editor.

## Goals / Non-Goals

**Goals:**
- Make the reserved route's roster and base URL runtime-editable through the existing store + hot-reload path, with env/baked values as a永远可回滚的 seed.
- Make the default lane self-healing against the 2026-10-01 outage class (dark default + boot re-anchor).
- Close the `contextWindow` editability gap in the same editor pass.

**Non-Goals:**
- Model-switch latency (dsh restart transport — separate change).
- Per-override API keys (env stays the only key source; an override URL must accept the env key).
- Guarding per-user cell bindings (v1 guards the global default only; see Open Questions).

## Decisions

**D1 — Override lives as a sibling key in `llm-providers.json`.**
`{ providers: [...], volcesOverride: { baseUrl?, models?, discovery?, updatedAt } }`. One file, one write chain, one lock — no new concurrency surface; `readProvidersDoc` is already shape-tolerant (reads `doc.providers`, ignores the rest), so old code ignores the key and rollback is "revert image". Alternative rejected: a separate `llm-volces-override.json` (mirrors `llm-default.json` precedent but adds a second lock/ordering domain for no gain); promoting `volces` to a normal provider row (key would have to live in the row or desync from env rotation).

**D2 — `dsh-profile.js` reads the override through the existing lazy import.**
In `buildLlmProfile`, the volces route's roster becomes `override.models ?? VOLCES_MODELS` and its base URL `override.baseUrl || env || baked default`, fetched via the same `await import("./llm-providers.js")` used for user providers (the cycle-safe pattern already there). No new module edges.

**D3 — `RESERVED_IDS` narrows to field-level, not route-level.**
`updateProvider("volces", body)` accepts exactly `{ baseUrl?, models? }` and writes the override doc (models validated by the existing array validator — unique ids, positive-int `contextWindow`/`maxTokens`); name/type/apiKey mutations and deletion still throw `invalid: reserved provider id`. `GET /api/llm/providers` synthesizes the reserved record from the *effective* values and adds `override: { active, baseUrl?, rosterSize }` — no key material, as today.

**D4 — Reserved sync = the user-provider merge path, target swapped.**
The dry-run branch in `syncProvider` is deleted; the reserved route flows through the same classify → lock → merge (`serving` appended with family metadata, no-evict, family-rank order) → persist → reload pipeline, writing `volcesOverride.models/discovery` instead of a provider row. `syncInFlight` and the write lock keep their current semantics (one sync cluster-wide, 409 on contention).

**D5 — Guard is a server-side helper triggered at three points, probe-based.**
`server/llm-guard.js` exporting `guardDefaultLane(ctx, { reason })`: resolves the current default (`ctx.defaultModel` at runtime; the boot `pick` at startup), fires one 1-token completion against the route's effective baseUrl + env key with a bounded timeout, and classifies via the sync taxonomy:
- definitive dark (`model_not_found` / unauthorized-class 4xx) → switch: pick first model whose last-sync `discovery` status is `serving` (searching `ctx.dshModels` order), `setDefault`, update `ctx.defaultModel`, broadcast `model_fallback { from, to, reason }`; no serving known → keep default, log + status surface.
- network error / timeout → keep default, no broadcast (a flapping gateway must not move the default).
Trigger points: (1) boot — inside the `server.js` default-resolution block, before the initialize handshake is *awaited into the session* (listen-first boot keeps the app answering 503→ready during the probe); (2) after `syncProvider` completes in the route; (3) after `PUT /api/llm/default` applies. Boot-leg broadcast is best-effort (no clients yet — `current_model` on connect carries the state). Alternative rejected: last-sync-classification-only fallback (zero cost but stale — it would have *kept* deepseek on 09-30's flap and missed 10-01's disappearance until someone synced).

**D6 — UI deltas ride existing components.**
`ProviderCard`: reserved card keeps lock/delete-hidden but renders the roster editor + base-URL override field + clear-override action + `override active` indicator; sync button drops the dry-run label. `ModelListEditor`: adds a `contextWindow` input beside each row's `maxTokens` (both optional, positive-int). `model_fallback` WS event → toast in the web client (locale strings ×5). MP client: display-only as today, no change.

## Risks / Trade-offs

- [Boot adds one probe (~1–10 s bounded)] → listen-first boot already serves 503→ready around the handshake; timeout failure keeps the default and logs — boot never stalls on the guard.
- [Crash-looping pod re-probes every start, spending 1 token each] → negligible per-probe cost; bounded by the pod restart rate itself.
- [Override baseUrl points at a gateway that rejects the env key] → the Test button and sync classification surface the mismatch immediately; documented constraint (override URL must accept the env key) rather than per-override keys (proposal-locked).
- [Family-rank fallback order vs operator intent] → fallback is a pointer switch, visible via `model_fallback` and reversible with one Models-page action; never silent.
- [Sync merge into the override makes the baked roster invisible] → the card shows `override active` + clear action; clearing is the one-click rollback to env/baked values.

## Migration Plan

Deploy as a normal image roll. No data migration: an absent `volcesOverride` key reproduces today's behavior exactly (env/baked projection), and old code ignores the key if a later rollback leaves one behind. Post-deploy probe: on the Models page, edit the reserved roster (add an id), confirm the picker updates without a restart; clear the override, confirm rollback; stop the gateway's deepseek lane (or wait for the next drift) and confirm boot falls back with the toast.

## Open Questions

- Should the guard also cover a cell user's personal binding (boot `boundModel`), or stay global-default-only for v1? (Spec scoped the default; binding owners currently see a per-turn error and can switch — deferrable without touching the specs.)
- `model_fallback` toast copy per locale — filler task at implementation time.
