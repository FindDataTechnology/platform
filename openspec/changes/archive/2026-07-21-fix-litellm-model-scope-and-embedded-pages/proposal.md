## Why

Two user-facing bugs block normal use of the chat app:

1. The pi-agent model selector exposes non-LiteLLM models instead of being scoped to LiteLLM-only. When the LiteLLM `/v1/models` fetch succeeds the list is correct, but on any fetch failure `getAvailableModels` falls back to the **entire** SDK registry - which includes the native Volces built-in chat models plus the LiteLLM extension's upstream-named models - so "all models" leak into the selector. The startup default-model resolution is also broken: its `isLitellmModel` helper checks `m.provider === "litellm"`, but the LiteLLM extension registers models under upstream provider names (`deepseek`, `volcengine`, …), so the helper never matches and the "prefer LiteLLM as default" logic is dead code.
2. The OpenConnector and LiteLLM sidebar pages are inaccessible. OpenConnector **always** renders a "not configured" placeholder because `/api/config` never reports `openconnectorEnabled` (the React `OpenConnectorPage` gates on that flag). The LiteLLM page embeds the proxy **root** (`/litellm-web` → `LITELLM_BASE_URL/`), which serves LiteLLM's JSON API, not the management UI that lives at `/ui` - so the frame shows broken content.

## What Changes

- **Scope the pi-agent to LiteLLM-only when LiteLLM is configured.** The model selector (`list_models`), the startup default model, and runtime switching (`set_model` / `/model`) are restricted to models routed through the LiteLLM proxy. Native Volces chat models no longer appear in the selector and cannot be switched to while LiteLLM is configured. **Behavior change:** when LiteLLM is configured but unreachable, the selector reports a clear error and shows no models rather than silently falling back to Volces - this is intentional per the "LiteLLM-only" requirement.
- **Fix LiteLLM default-model detection.** Replace the `m.provider === "litellm"` check (which never matches the extension's upstream-named models) with detection against the LiteLLM proxy's actual model set, so the agent starts on a LiteLLM-routed model when LiteLLM is configured.
- **Expose `openconnectorEnabled` via `/api/config`** so the OpenConnector embedded view renders its iframe when enabled (and the disabled placeholder when not), mirroring how `litellmEnabled` is already exposed.
- **Open the LiteLLM management UI in a new tab** instead of embedding a broken iframe. The LiteLLM dashboard is a Next.js SPA with basePath `/ui` and an interactive sign-in flow that the server-side token-injecting proxy cannot satisfy (the dashboard hard-redirects to `/ui/*` and requires a UI login); embedding it same-origin is unreliable. The view now renders an open-in-new-tab link to `litellmManagementUrl` (`${LITELLM_BASE_URL}/ui`). The server-held key is never exposed.
- **Fix the embedded-frame "blocked" overlay** so it only shows when the iframe genuinely fails to load (X-Frame-Options/CSP), not 5s after a successful fast load (the unconditional timer used to re-block after `onLoad`).
- **Stop the SPA fallback from shadowing the OpenConnector `/v1/*` proxy** (exclude `/v1/` from the fallback regex) so the embedded OC runtime UI's `/v1` API calls reach the runtime instead of being served the React `index.html`.
- The Volces provider remains registered for the documents RAG (which uses it directly via `initStore`, independent of the agent's model registry) and as the sole chat provider when LiteLLM is **not** configured (preserving graceful degradation). It is only excluded from the chat agent's selectable/usable set when LiteLLM is configured.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `model-selection`: When LiteLLM is configured, the model list, default model, and switchable set are LiteLLM-only; the "fall back to configured-provider models" allowance is removed for the LiteLLM-configured case (retained only when LiteLLM is not configured). Default-model LiteLLM detection is corrected.
- `litellm-web`: The embedded iframe loads the management UI at `/litellm-web/ui` rather than the proxy root; LiteLLM-enabled state continues to be exposed to the client via `/api/config`.
- `open-connector-web`: The server exposes OpenConnector-enabled state via `/api/config` so the embedded view renders the iframe when enabled and the disabled state when not.

## Impact

- **`server.js`**: `getAvailableModels`, `resolveDefaultModel`, `switchModelTo`, the `isLitellmModel`/`hasAuth` scoping helpers, the `/api/config` route, and the SPA-fallback regex (exclude `/v1/` so the OC `/v1` proxy is not shadowed).
- **`web/src/pages/EmbeddedServicePages.tsx`**: `LiteLLMPage` now renders an open-in-new-tab link to `litellmManagementUrl` (no iframe); `EmbeddedFrame` overlay only blocks on genuine load failure.
- **`litellm-models.js`**: may expose a helper to resolve/identify LiteLLM models for default selection and switch validation.
- **E2E**: `e2e/embedded-views.spec.js` (assert the iframe targets the UI path and that `openconnectorEnabled` flows from the real `/api/config`, not just a stub) plus any model-selection e2e.
- **Specs**: delta files for `model-selection`, `litellm-web`, `open-connector-web`.
- No external dependencies change. Documents RAG is unaffected. The one user-visible behavior change is the removal of the silent Volces fallback when LiteLLM is configured-but-down (replaced by an explicit empty-list + error).
