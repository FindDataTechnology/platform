## 1. Scope pi-agent to LiteLLM-only (provider registration)

- [x] 1.1 In `server.js` `extensionFactories`, register the `litellmExtension` **only** when `litellmEnabled`, and the Volces provider factory **only** when `!litellmEnabled` (today Volces is always registered and LiteLLM is added conditionally on top).
- [x] 1.2 Keep `authStorage.setRuntimeApiKey("volces", VOLCES_API_KEY)` (still used by the non-LiteLLM path and harmless otherwise); confirm `documents.js` `initStore` still receives `VOLCES_BASE_URL`/`VOLCES_API_KEY` directly (unchanged).
- [x] 1.3 Remove/rewrite the now-stale comments in `server.js` (the `hasAuth`/`isLitellmModel` block ~lines 102-112 and the shadowing rationale) that described registering both providers and shadowing Volces.

## 2. Fix default-model + selector + switch logic

- [x] 2.1 Fix `isLitellmModel` / LiteLLM detection: replace the `m.provider === "litellm"` check (which never matches the extension's upstream-named models) with `hasAuth(m) && m.provider !== "volces"` (or simply `hasAuth` on the LiteLLM-only path), so `resolveDefaultModel()` actually prefers a LiteLLM-routed model.
- [x] 2.2 `resolveDefaultModel()`: when `litellmEnabled` and no LiteLLM-routed model is resolvable (proxy down, extension registered nothing), log a clear error and return `null` (pass no explicit model) instead of silently falling back to Volces.
- [x] 2.3 `getAvailableModels()`: when `litellmEnabled`, the fetch-failure fallback already returns `registry.filter(hasAuth)` (LiteLLM-only under task 1.1). If that is empty, return `[]` and log a warning so the selector shows "no models" rather than a Volces list. Verify no Volces id can appear in any branch.
- [x] 2.4 `switchModelTo()` / `findInRegistry()`: when `litellmEnabled`, restrict candidate models to LiteLLM-routed models (exclude `provider === "volces"`) so a `/model glm-5.2` or `set_model` to a Volces id is rejected with an error rather than silently matched.
- [x] 2.5 Manually verify with LiteLLM up: selector shows only LiteLLM `/v1/models` ids, default model is a LiteLLM model, switching works between LiteLLM models, and `/model <volces-id>` is rejected. (Used `/lawcraw-server-start`; verified via e2e - no Volces-provider models, default `deepseek/deepseek-v4-pro`, switching passes, full fast suite green.)

## 3. Fix OpenConnector page access (`/api/config`)

- [x] 3.1 In `server.js` `/api/config` route, add `openconnectorEnabled: openConnector.openConnectorEnabled` to the JSON response (mirrors the existing `litellmEnabled`).
- [x] 3.2 Confirm `OpenConnectorPage` (`web/src/pages/EmbeddedServicePages.tsx`) renders the `/oc-web` iframe when `openconnectorEnabled` is true and the placeholder when false (already implemented; just verifying the flag now flows).

## 4. Fix LiteLLM + OpenConnector page access

- [x] 4.1 Probe live LiteLLM (lawcraw): confirm `/ui` serves the management dashboard (Next.js SPA, basePath `/ui`, login required) and `/` serves Swagger. Embedding behind `/litellm-web` is infeasible (basePath hard-redirect to `/ui/*` + interactive login not satisfiable by token injection).
- [x] 4.2 `web/src/pages/EmbeddedServicePages.tsx`: `LiteLLMPage` renders an open-in-new-tab link to `litellmManagementUrl` (no iframe). Revert the `/litellm-web/ui` iframe attempt and the LiteLLM embed-proxy additions.
- [x] 4.3 `EmbeddedFrame`: fix the "blocked" overlay so it only shows when `onLoad` has not fired by 5s (ref-tracked), not unconditionally 5s after a fast load.
- [x] 4.4 `server.js`: exclude `/v1/` from the SPA fallback regex so the OpenConnector `/v1` reverse proxy is not shadowed (the OC runtime UI's `/v1` API calls now reach the runtime).
- [x] 4.5 Manually verify (lawcraw stack): LiteLLM page shows the open-in-new-tab link (`href` = `litellmManagementUrl`, `target="_blank"`, no iframe); OC page embeds the runtime UI iframe (no false "blocked" overlay; `/api/connections` returns 200).

## 5. E2E tests

- [x] 5.1 `e2e/embedded-views.spec.js`: assert `LiteLLMPage` renders an open-in-new-tab link (`href` = `litellmManagementUrl`, `target="_blank"`, no iframe) when enabled, and the placeholder when disabled.
- [x] 5.2 `e2e/embedded-views.spec.js`: add a test that does NOT stub `/api/config` (or stubs the real server shape) asserting `openconnectorEnabled` is present in the response and drives the OpenConnector page render (iframe when enabled, placeholder when disabled).
- [x] 5.3 If a model-selection e2e exists, add/update assertions that the model list contains no Volces model ids when LiteLLM is configured, and that switching to a Volces id is rejected.
- [x] 5.4 Run the full e2e suite (`npm run test:e2e` or project equivalent) and confirm green.

## 6. Spec sync & wrap-up

- [x] 6.1 Run `openspec validate fix-litellm-model-scope-and-embedded-pages --strict` (or `openspec status`) and fix any deltas flagged.
- [ ] 6.2 After implementation, `/opsx:sync` the delta specs into `openspec/specs/{model-selection,litellm-web,open-connector-web}/` and `/opsx:archive` the change.
