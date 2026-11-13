# Tasks — rename-litellm-upstream-env-keys

## 1. Rename + fallback at the resolution boundary

- [x] 1.1 In `supervisor/descriptors.js`, replace the `VOLCES_PLAN_*` child-env entries with `LLM_UPSTREAM_*`, resolving `agentEnv.LLM_UPSTREAM_* ?? agentEnv.VOLCES_PLAN_* ?? <default>` (new name wins, legacy fallback, base-URL default kept). Inject both new and legacy names into the child env for custom-yaml compat. Reword the inline comment from "Volces" to "upstream".

## 2. Pass-through key lists

- [x] 2.1 Add `LLM_UPSTREAM_BASE_URL`, `LLM_UPSTREAM_KEY_1`, `LLM_UPSTREAM_KEY_2` to `SETTING_KEYS` in `electron/config/settings.js` (keep the legacy `VOLCES_PLAN_*` entries).
- [x] 2.2 Add the same three new keys to `SETTING_KEYS` in `local-services.js` (keep legacy entries; keep the two lists in sync).

## 3. Default LiteLLM config

- [x] 3.1 In `litellm.yaml`, replace all `os.environ/VOLCES_PLAN_BASE_URL`, `os.environ/VOLCES_PLAN_KEY_1`, `os.environ/VOLCES_PLAN_KEY_2` references with the `LLM_UPSTREAM_*` equivalents; update the header comment to drop "Volces".

## 4. Docs / templates

- [x] 4.1 Update `.env.example` to use the new `LLM_UPSTREAM_*` names with a provider-neutral comment.
- [x] 4.2 Update `README.md` / `DEPLOY.md` references to the legacy names. (No-op: the legacy `VOLCES_PLAN_*` names never appeared in docs - verified by grep.)

## 5. Verify

- [x] 5.1 `npm start` with only new names set → LiteLLM child env carries the values; upstream calls succeed. (Verified at the resolution boundary: `getDescriptors` with new-only `agentEnv` → child env carries the values under both new and legacy names.)
- [x] 5.2 With only legacy `VOLCES_PLAN_*` set → same result (fallback works). (Verified: legacy-only `agentEnv` resolves into `LLM_UPSTREAM_*` child vars.)
- [x] 5.3 With both set → new name wins. (Verified: `LLM_UPSTREAM_*` value wins; legacy child var mirrors the winning value.)
- [x] 5.4 Run `openspec validate rename-litellm-upstream-env-keys` and fix any issues.
