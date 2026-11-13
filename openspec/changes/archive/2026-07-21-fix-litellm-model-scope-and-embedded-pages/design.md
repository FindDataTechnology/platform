## Context

The chat app (`server.js` + React SPA under `web/`) has two user-reported bugs:

1. **Model selector shows "all models".** `getAvailableModels()` returns the LiteLLM proxy `/v1/models` list when the fetch succeeds, but on *any* fetch failure it falls back to `(modelRegistry.getAvailable() ?? []).filter(hasAuth)` - which includes the native Volces built-in chat models (`deepseek-v4-pro`, `deepseek-v4-flash`, `glm-5.2`) **and** the LiteLLM extension's upstream-named models. The startup default-model resolver is independently broken: `isLitellmModel(m)` checks `m.provider === "litellm"`, but the LiteLLM extension registers its models under upstream provider names (`deepseek`, `volcengine`, `openrouter`, …), so the check never matches and `resolveDefaultModel()`'s "prefer LiteLLM" branch is dead - it falls through to `available.filter(hasAuth)[0]`, which can be a Volces model.

2. **OpenConnector + LiteLLM pages inaccessible.**
   - `OpenConnectorPage` gates its iframe on `config.openconnectorEnabled`, but `/api/config` returns only `{ litellmEnabled, litellmManagementUrl, documentsEnabled }` - it never includes `openconnectorEnabled`. So the page *always* renders the "not configured" placeholder, even when OpenConnector is enabled. (`open-connector.js#getPublicConfig()` exposes `enabled` at `/api/openconnector/config`, but the React page reads `/api/config`.) The e2e stubs `/api/config`, so it never caught this.
   - `LiteLLMPage` embeds `src="/litellm-web"`, which the proxy maps to `LITELLM_BASE_URL/` (root). LiteLLM serves its management UI at `/ui` (the codebase's own `litellmManagementUrl = LITELLM_BASE_URL + "/ui"`); the root serves the JSON API. So the frame loads broken/JSON content. (When LiteLLM is also unreachable, the proxy returns 502 - an environmental failure, not a code bug.)

The LiteLLM proxy is currently unreachable from this machine (probed `192.168.1.4:4000` -> connection failure), which is why the model fallback and the LiteLLM 502 are manifesting right now; the code fixes below make the app correct regardless of proxy state.

## Goals / Non-Goals

**Goals:**
- When LiteLLM is configured, the pi-agent (selector, startup default, runtime switching) is scoped to LiteLLM-routed models only - no Volces chat models ever appear or are selectable.
- The OpenConnector page renders its embedded iframe when OpenConnector is enabled (and the disabled placeholder when not).
- The LiteLLM page embeds the actual management UI, not the JSON API root.
- Preserve graceful degradation: when LiteLLM is **not** configured, Volces remains the sole chat provider (unchanged). The documents RAG is unaffected.

**Non-Goals:**
- Curating/filtering which LiteLLM models appear (all proxy-routed models remain selectable).
- Removing the Volces provider entirely from the codebase (still used for documents RAG via `initStore` and as the non-LiteLLM fallback).
- Changing the OpenConnector nav-link gating (it stays always-present per `app-navigation`; only the page's enabled detection is fixed).
- Fixing the LiteLLM-proxy-is-down environmental condition (out of scope; the proxy returns a clear 502 already).

## Decisions

### Decision 1: Enforce LiteLLM-only by registering exactly one chat provider (Option B)

When LiteLLM is configured, register **only** the `litellmExtension` in `extensionFactories`; when it is not configured, register **only** the Volces factory. Today both are registered whenever LiteLLM is enabled (Volces always, LiteLLM conditionally), and the LiteLLM extension shadows Volces for shared ids.

**Why over alternatives:**
- *Alternative A (keep both registered, exclude Volces via `provider !== "volces"` in selector/switch/default).* Requires adding the discriminator in three places and leaves Volces registered so the SDK could still default to it - a leak against "LiteLLM-only". More code, less robust.
- *Option B* removes Volces from the agent's registry by construction, so `registry.filter(hasAuth)` is LiteLLM-only in every code path (including the fetch-failure fallback). It also makes the dead `isLitellmModel` check unnecessary and lets us delete the shadowing/allowlist rationale comments.

Consequence: `documents.js` is unaffected because it calls `initStore({ baseUrl: VOLCES_BASE_URL, apiKey: VOLCES_API_KEY, model: DOCUMENTS_MODEL })` directly - it never goes through the pi model registry. `authStorage.setRuntimeApiKey("volces", ...)` can remain (harmless; only consumed when Volces is registered).

### Decision 2: Fix default-model detection against the LiteLLM set

Under Decision 1, when LiteLLM is configured every authed registry model is LiteLLM-routed. Replace `isLitellmModel(m) = m.provider === "litellm"` with a check that is true for authed non-Volces models (e.g. `hasAuth(m) && m.provider !== "volces"`), or simply use `hasAuth` directly on the LiteLLM-only path. `resolveDefaultModel()` then genuinely returns a LiteLLM-routed model. If LiteLLM is configured but no model is resolvable (proxy down at startup, extension registered nothing), `defaultModel` is `null` and the server logs a clear error; the SDK receives no explicit model.

### Decision 3: Selector behavior when LiteLLM is configured but unreachable

`getAvailableModels()` keeps fetching the proxy `/v1/models`. On success -> proxy list (LiteLLM-only). On failure -> fall back to `registry.filter(hasAuth)`, which under Decision 1 is already LiteLLM-only (the extension's models, if any) - **never** Volces. If that is also empty, return `[]` and log a warning so the selector shows "no models" rather than a silent Volces list. This is the intentional behavior change: when LiteLLM is configured-but-down, the chat selector is empty + errors, rather than silently offering Volces.

### Decision 4: Expose `openconnectorEnabled` via `/api/config`

Add `openconnectorEnabled: openConnector.openConnectorEnabled` to the `/api/config` JSON. The React `OpenConnectorPage` already reads `config.openconnectorEnabled`, so this single addition makes the iframe render when enabled and the placeholder render when not. No client change needed.

### Decision 5: LiteLLM page opens the management UI in a new tab (not embedded)

Implementation against a live LiteLLM (lawcraw cluster) revealed that embedding the dashboard is infeasible: (1) the dashboard is a Next.js SPA built with basePath `/ui`, so loading it at `/litellm-web/ui` causes a hard redirect to `/ui/*` which the proxy serves as the wrong content (Swagger at the root, or 405 "Method Not Allowed" for client routes like `/ui/login`); (2) the dashboard requires an interactive sign-in (`/ui/login`) that the server-side token-injecting proxy cannot satisfy (it has no localStorage session, and the proxy-injected `Authorization` header does not auto-login the UI). Rather than build a custom shell-serving proxy and solve the login, `LiteLLMPage` now renders an open-in-new-tab link to `litellmManagementUrl` (`${LITELLM_BASE_URL}/ui`), which the user opens and signs into directly. The server-held `LITELLM_API_KEY` is never exposed to the browser. The `/litellm-web` reverse proxy remains mounted (pre-existing) but is no longer used by the view.

### Decision 6: Fix the embedded-frame "blocked" overlay and unshadow the OC `/v1` proxy

Two fixes for the OpenConnector embedded page (which keeps the iframe approach): (a) `EmbeddedFrame`'s overlay set `blocked=true` unconditionally 5s after mount, so a fast-loading iframe was covered by a false "could not be loaded" overlay once `onLoad` had already fired; it now only blocks when `onLoad` has not fired by 5s (tracked via a ref). (b) The SPA fallback regex (registered before the proxy routes) shadowed `/v1/*`, serving `index.html` for the OC runtime's `/v1` API calls; `/v1/` is now excluded from the fallback so those calls reach the OpenConnector proxy.

## Risks / Trade-offs

- **[No chat when LiteLLM is configured but down]** -> Intentional per "LiteLLM-only". Mitigation: clear error in the selector + server log; user brings up LiteLLM (e.g. `/lawcraw-server-start`). If this proves too strict, the fallback to Volces can be reinstated as a hidden emergency path - flagged as an Open Question.
- **[LiteLLM page opens the management UI in a new tab, not embedded]** -> The dashboard's basePath `/ui` and interactive login make same-origin embedding infeasible (Decision 5). Trade-off: the user signs into LiteLLM in a separate tab rather than seeing it inline. Robust and honest; the server-held key is never exposed.
- **[Removing Volces from the registry when LiteLLM is enabled changes SDK default behavior]** -> Only matters when LiteLLM is down (covered above). When LiteLLM is up, the default is a LiteLLM model (the desired behavior).
- **[LiteLLM extension may register a static model list that drifts from the proxy]** -> The selector already uses the live `/v1/models` list as the source of truth; `switchModelTo`'s fuzzy matching bridges minor id drift. Pre-existing behavior, unchanged by this change.

## Open Questions

- **Volces fallback when LiteLLM is down?** Decision 3 removes the silent Volces fallback (per the user's "only LiteLLM" request). Confirm this is desired vs. keeping Volces as a hidden fallback so chat still works when LiteLLM is briefly unreachable. Default taken: LiteLLM-only (no Volces fallback).
- **OC runtime UI stuck on "Loading runtime data..."** -> Observed natively at the lawcraw OpenConnector runtime (not a PAAS proxy issue - the runtime returns 200 but its SPA does not hydrate past the loading state, likely needing runtime-side configuration/tokens). Out of scope for this change; the PAAS embed correctly renders the iframe and proxies its API calls.
