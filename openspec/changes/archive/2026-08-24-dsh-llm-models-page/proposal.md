# dsh-llm-models-page

## Why

Today the only LLM surface in the UI is a `<select>` dropdown in the sidebar that lists models reported by dsh. There's no way to see *which providers are configured*, no way to test a connection, no way to add a new provider, and no way to retire one. Adding a new LLM today means editing `settings.yaml` and restarting the dsh child process by hand. dsh-llm already runs server-side and exposes `ctx.llm.discoverModels()`; we just have no UI to drive it.

This change adds a **first-class Models page** at `/models` that lists all configured providers with their discovered models, lets the user add/edit/remove providers (writing a `settings.yaml` patch and restarting dsh), and test the live connection to a base URL. The sidebar model selector becomes a shortcut to "set the default" — the real configuration happens on the page.

## What Changes

- **New** `/api/llm/providers` (GET): return current provider list, each with name, base URL, has-key (boolean, never the key itself), discovered model ids, and last-test status.
- **New** `/api/llm/providers` (POST): add a new provider. Server writes a patch to `settings.yaml` under `$DSH_HOME`, calls `dshBridge.restart()`, and returns the updated list.
- **New** `/api/llm/providers/:id` (PUT): edit a provider (rename, change base URL, replace API key). Same write-and-restart path.
- **New** `/api/llm/providers/:id` (DELETE): remove a provider.
- **New** `/api/llm/providers/:id/test`: probe the base URL with the configured key (lightweight GET to a known live endpoint per provider type) and return `{ ok, latencyMs, error? }`.
- **New** `/api/llm/default` (GET / PUT): read / write which model id is the current default — replaces the sidebar `<select>` with a "default" pointer.
- **New** `ModelsPage.tsx` (top-level `/models`): provider cards, Add/Edit/Delete dialogs, Test button, default-model selector.
- **Deprecate** the sidebar model `<select>` as a config surface (still shows current default, but the dropdown is read-only — clicking it navigates to `/models`).
- **WS**: the existing `set_model` flow keeps working (sets the default), but a live model switch no longer restarts dsh when only the *default* changes within a single provider; restarting is only required on provider add/edit/delete (no per-model restart).
- **i18n**: add `modelsPage.*` keys.

The sidebar Agent `<select>` is unchanged (it picks an `agent-local` / `agent-remote` switch, which is a different axis from LLM providers).

## Capabilities

### New Capabilities
- `llm-model-management`: server-side CRUD over the dsh LLM profile (settings.yaml patch + restart), per-provider test endpoint, default-model pointer, and the `/models` UI page that drives it.

### Modified Capabilities
- `app-navigation`: the `/models` tab is now backed by real content (this change links to that placeholder added by `ui-nav-restructure`).
- `model-selection`: the "change model" action is now a default-model pointer write (PUT `/api/llm/default`); a provider switch still triggers `dshBridge.restart({ provider, model })`.

## Impact

- **`server.js`**: new `/api/llm/*` route group; new WS bridge RPC for "restart with profile patch" (currently `dshBridge.restart({ provider, model })` — extend to accept `profilePatchPath`).
- **`dsh-profile.js`**: expose a `readProviders()` function that parses the generated `settings.yaml` (or the in-memory representation we already write) and returns the same shape as the new API. Add `writeProviderPatch()` for the POST/PUT/DELETE handlers.
- **`dsh-bridge.js`**: `restart({ profilePatchPath })` reads the patch overlay and merges with the base settings on next child spawn. Restart is the only safe way to pick up `settings.yaml` changes — there is no live reload RPC in dsh today.
- **`web/src/pages/ModelsPage.tsx`** → **new**.
- **`web/src/components/llm/`** → **new**: `ProviderCard.tsx`, `ProviderForm.tsx`, `TestConnectionButton.tsx`, `ModelList.tsx`.
- **`web/src/components/Sidebar.tsx`**: the model `<select>` becomes read-only (or replaced with a clickable chip that navigates to `/models`).
- **`web/src/locales/*/common.json`**: add `modelsPage.providers / add / edit / delete / test / default / setDefault / confirmDelete / keyMasked / neverExpose / restartNotice`.
- **Risk**: `settings.yaml` patch race conditions if two edits happen concurrently. The server uses an in-process mutex (one edit at a time) — concurrent UI clicks get a 409.
- **Risk**: dsh restart tears down the active chat session and resumes it from disk. The user sees a brief "reconnecting" in the status row; this is the same behavior as today's `set_model` on provider change, so no new UX is introduced.
- **Risk**: API key handling. Keys are read from env on first generation, then from `settings.yaml` on subsequent edits. We never log, never echo, never return the key — `has-key: true/false` is the only client-visible signal.

## Out of scope

- Per-model fine-tuning, custom model adapters, or non-OpenAI-compatible providers (covered by separate adapters if needed later).
- Multi-tenant LLM routing (a single user having multiple provider keys with usage quotas) — single default per deployment today, same as before.
- Cost / token-usage dashboards per provider — separate capability.
