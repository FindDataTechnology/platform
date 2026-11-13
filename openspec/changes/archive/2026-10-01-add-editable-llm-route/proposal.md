# Proposal: add-editable-llm-route

## Why

The built-in env route (`volces`) is the deployment's actual default lane, yet it is a read-only projection of image-baked code (`VOLCES_MODELS` in `dsh-profile.js`) plus env (`LLM_BASE_URL`/`LLM_API_KEY`). Gateway rosters drift faster than image releases — 2026-09-30 saw a prefix flip and a lane go dark on the same day, 2026-10-01 saw `deepseek*`/`glm*` vanish from `/v1/models` entirely — and every time it drifts, fixing the built-in roster means an image rebuild or in-pod surgery (the 09-30 "data track" hack existed precisely because the image path was too slow). Worse, a dark default lane combined with the boot-time re-anchor (active model resolves to `DEFAULT_MODEL` via `writeLlmProfile()`) left every new session 404ing after the 10-01 restart. Separately, `contextWindow` (max input) is not editable anywhere in the UI, and sync on the reserved route is a dry run that persists nothing.

## What Changes

- **Reserved-route override**: a persisted `volcesOverride` document inside `llm-providers.json` (`{ baseUrl?, models[] }`). Roster and base-URL resolution becomes **override > env > baked `VOLCES_MODELS`**. Admin-gated, written through the existing write-chain, applied via the existing hot-reload path (`writeLlmProfile` + Chokidar) — zero dsh restart, zero image rebuild. Clearing the override is the rollback (back to the image+env projection). The API key stays env-only: never editable in the UI, never persisted to the store; provider deletion stays unavailable for the reserved route.
- **Sync persists for the built-in route**: `POST /api/llm/providers/volces/sync` stops being a dry run — serving ids merge into the override roster (same no-evict rule as user providers: hand-tuned entries are never rewritten).
- **UI unlock**: the Models page's reserved card gains the roster editor and a base-URL override field (delete and key editing remain hidden). The per-model editor gains a `contextWindow` input alongside the existing `maxTokens` one, for user providers and the override alike (server schema already accepts both).
- **Default-lane guard**: at boot, after a sync, and after a default-pointer change, the platform probes the default model with one 1-token completion. On a definitive dark answer (`model_not_found` / unauthorized-class 4xx) it falls back to the first known-serving model (last sync classification), switches the default pointer, and broadcasts a `model_fallback` event so the Models page and connected clients surface the substitution. Network errors and timeouts do **not** trigger fallback (a flapping gateway must not silently move the default).

Non-goals: model-switch latency (the ~10 s dsh restart transport — a dsh-side custom RPC, separate deep-water change); per-user provider rosters.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `llm-model-management`: the reserved env route's roster and base URL become runtime-editable through a persisted override with defined precedence; sync on the reserved route persists; the model-list editor exposes `contextWindow` alongside `maxTokens`.
- `model-selection`: startup default-model selection gains the serving-guard semantics — probe the default, fall back on definitive dark answers with a broadcast, never fall back on network errors.

## Impact

- `llm-providers.js`: `volcesOverride` document in the store, `RESERVED_IDS` gate narrowed (roster/baseUrl editable, delete/key still refused), sync persistence for the reserved route.
- `dsh-profile.js`: roster resolution precedence (override > env > `VOLCES_MODELS`).
- `server/routes/llm.js`: GET providers projects override state; PUT accepts override mutations; guard wiring after sync/default-set.
- Boot path (`server/context.js` / `agent-session.js`): the 1-token default probe + fallback + `model_fallback` broadcast.
- `web/src/components/llm/` (`ProviderCard`, `ModelListEditor`), five locales, e2e coverage for the models page and the fallback path.
- Operations: gateway drift becomes a Models-page fix instead of a rebuild — the 10-01 outage class (dark default + restart) is auto-caught.
