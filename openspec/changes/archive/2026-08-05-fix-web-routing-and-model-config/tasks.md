## 1. New-chat navigation (bug 1)

- [x] 1.1 In `web/src/components/Sidebar.tsx`, import `useNavigate` from `react-router-dom`; in the "+ New" button `onClick` (line ~73), call `navigate("/chat")` in addition to `send({ type: "new_session" })` so the view switches to chat from any page.
- [x] 1.2 Verify from each non-chat route (`/documents`, `/dashboard`, `/history`, `/openconnector`, `/litellm`): clicking "+ New" navigates to `/chat` and starts a fresh session (session list refreshes, chat view is shown).

## 2. OpenConnector page render (bug 2)

- [x] 2.1 Rebuild the OC web console so `resources/openconnector/dist/web/assets/` is populated: run `npm run build:web` inside `resources/openconnector/` (or re-run `node scripts/build-openconnector.js`). Confirm `dist/web/assets/index-*.js` + `*.css` now exist alongside `index.html`.
- [x] 2.2 Audit `scripts/build-openconnector.js` copy logic (`SKIP_DIRS`/`TOP_LEVEL_SKIP_DIRS` ~lines 42-46, the copy loop ~120-125): confirm `dist/web/assets/` is not skipped; add a post-build assertion that throws if `dist/web/assets/` is empty (fail loud instead of silently shipping a broken UI).
- [x] 2.3 Verify via the running server: `curl -s -o /dev/null -w "%{content_type}" http://localhost:3000/assets/<hash>.js` returns `application/javascript` (not `text/html`); load `/openconnector` and confirm the iframe renders the OOMOL Connect runtime UI (not blank, no false "blocked" overlay).

## 3. LiteLLM API surface (bug 3)

- [x] 3.1 In `server.js` `/api/litellm/credentials` (~line 919), add `apiBaseUrl: isLocal ? LITELLM_BASE_URL : null` to the JSON response (reuses the existing `isLocal` gate; base URL is non-secret and already derivable from `litellmManagementUrl`).
- [x] 3.2 In `web/src/pages/EmbeddedServicePages.tsx`, extend `useLitellmCredentials` to capture `apiBaseUrl` and render it as a copyable field in `LiteLLMPage` next to the master-key block (gated on presence, same as the key).
- [x] 3.3 Verify: `/api/litellm/credentials` returns `apiBaseUrl` = the live proxy URL (e.g. `http://localhost:53007`); the LiteLLM page shows copyable API URL + master key + the open-in-new-tab dashboard link; `curl -H "Authorization: Bearer <masterKey>" ${apiBaseUrl}/v1/models` returns the model list.

## 4. LiteLLM model config + Agent-harness default (bug 4)

- [x] 4.1 Edit `resources/litellm/default-config.yaml` `model_list`: remove `volces-coding`, `volces-coding-plan-v3`, and the coding/v3 `deepseek-v4-pro`; add `Agent-harness` (-> `openai/glm-5.2`), `doubao-seed-2-0-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2`, each with `api_base: os.environ/VOLCES_PLAN_BASE_URL` and TWO deployments per `model_name` (one using `api_key: os.environ/VOLCES_PLAN_KEY_1`, one `os.environ/VOLCES_PLAN_KEY_2`) for rotation. Keep `master_key: os.environ/LITELLM_API_KEY`.
- [x] 4.2 Apply the identical `model_list` to the live `litellm.yaml` (CWD) so the running proxy reloads the intended set without waiting for a first-run reseed.
- [x] 4.3 Add to `.env` (gitignored; secrets never committed): `VOLCES_PLAN_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3`, `VOLCES_PLAN_KEY_1=<first provided key>`, `VOLCES_PLAN_KEY_2=<second provided key>`, and `DEFAULT_MODEL=Agent-harness` (replace the existing `DEFAULT_MODEL=deepseek-v4-pro`).
- [x] 4.4 In `supervisor/descriptors.js` (litellm env block ~line 144), pass `VOLCES_PLAN_BASE_URL`, `VOLCES_PLAN_KEY_1`, `VOLCES_PLAN_KEY_2` through to the LiteLLM child process env (mirroring how `VOLCES_BASE_URL`/`VOLCES_API_KEY`/`LITELLM_API_KEY` are already passed so the existing `os.environ/` refs resolve).
- [x] 4.5 Restart the LiteLLM child (restart `npm start`) so it reloads `litellm.yaml`; verify `curl -H "Authorization: Bearer <masterKey>" ${LITELLM_BASE_URL}/v1/models` returns exactly `Agent-harness`, `doubao-seed-2-0-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2` (no `volces-coding*`).
- [x] 4.6 Verify the model selector shows only those 5 ids and the `current_model` on connect is `Agent-harness`; send a prompt and confirm `Agent-harness` routes to `glm-5.2` (a response returns). If `VOLCES_PLAN_KEY_2` is invalid, confirm LiteLLM router still succeeds via the other deployment and note it for the user.

## 5. Build, end-to-end verify, sync

- [x] 5.1 `npm run web:build` so `web/dist` picks up the `Sidebar.tsx` + `EmbeddedServicePages.tsx` changes.
- [x] 5.2 End-to-end smoke against the running server: (a) new-chat from `/documents` lands on `/chat`; (b) `/openconnector` renders the runtime UI; (c) `/litellm` shows API URL + master key + dashboard link and the link opens `/ui/`; (d) selector lists the 5 models with `Agent-harness` default; (e) a prompt to `Agent-harness` returns a `glm-5.2` response.
- [x] 5.3 `openspec validate fix-web-routing-and-model-config --strict`; fix any flagged deltas.
- [ ] 5.4 After implementation, `/opsx:sync` the delta specs into `openspec/specs/{app-navigation,litellm-web,litellm-provider}/` and `/opsx:archive` the change.
