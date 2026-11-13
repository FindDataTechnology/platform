## Context

The redesigned React SPA (`web/`, Vite + react-router-dom) replaced the legacy vanilla frontend. The backend (`server.js`) and the local-services launcher (`scripts/start.js` + `supervisor/` + `bootstrap/first-run.js`) are largely correct: a live probe confirms `litellmEnabled: true`, `openconnectorEnabled: true`, `litellmManagementUrl: http://localhost:53007/ui`, LiteLLM is reachable, and the `/oc-web` + `/litellm-web` token-injecting proxies are mounted. The four reported failures are therefore **not** backend config mismatches - they are frontend navigation gaps, an incomplete bundled-resource build, a missing API-URL surface, and a stale LiteLLM proxy model config.

Confirmed facts (live probe + code reads):

- `server.js` handles `new_session`/`list_sessions`/`switch_session` (lines 627, 833, 841) and broadcasts `session_changed`/`session_loaded`/`sessions`. The WS protocol the React client uses (`useChatStore.ts`, `useWebSocket.ts`) is implemented.
- `Sidebar.tsx:72-78` - the "+ New" button calls `send({ type: "new_session" })` only.
- `/oc-web` returns the OOMOL Connect HTML (HTTP 200), but `resources/openconnector/dist/web/` contains only `index.html` (623 B), `favicon.png`, `_headers` - **no `assets/` directory**. The HTML references `/assets/index-BAa98igr.js`; the runtime returns its SPA `index.html` for that path (catch-all), so the browser receives HTML where it expects an ES module and the OC SPA never boots. `scripts/build-openconnector.js:77` runs `npm run build:web` and copies `dist/web` - the bundled copy is incomplete.
- `/api/litellm/credentials` (`server.js:919`) returns `{ masterKey }` (works). `litellmManagementUrl` = `${LITELLM_BASE_URL}/ui` and `/ui` -> 307 -> `/ui/` (HTTP 200), so the dashboard link works. But the server **never exposes the raw LiteLLM API base URL** (`LITELLM_BASE_URL`, the dynamic port) - only the `/ui` URL. `.env` still has the stale `LITELLM_BASE_URL=http://localhost:4000` (harmless - the launcher overrides it to the real port when injecting into `server.js`).
- `litellm.yaml` (CWD) + template `resources/litellm/default-config.yaml` serve `volces-coding`, `volces-coding-plan-v3`, `deepseek-v4-pro` from `VOLCES_BASE_URL` (the *coding/v3* endpoint). `DEFAULT_MODEL=deepseek-v4-pro`. The selector already fetches `/v1/models` and is LiteLLM-only (the LiteLLM provider is the only registered chat provider when `litellmEnabled`), so the wrong *set* of models - not a Volces leak - is the problem.
- `web/dist` is current (newer than `EmbeddedServicePages.tsx`; built JS contains `litellm/credentials` and "Open LiteLLM dashboard").

Decision (user-confirmed): `Agent-harness` is a LiteLLM alias routing to `glm-5.2`; all four Volces plan/v3 models (`doubao-seed-2-0-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2`) are also individually selectable; both provided keys are used with rotation; base URL `https://ark.cn-beijing.volces.com/api/plan/v3`.

## Goals / Non-Goals

**Goals:**
- "+ New chat" navigates to `/chat` and starts a fresh session from any page.
- OpenConnector page renders the runtime UI (the bundled OC web build includes its assets).
- LiteLLM page renders a working dashboard link AND surfaces a copyable, reachable API base URL + master key for direct API use.
- LiteLLM proxy serves `Agent-harness` + the four plan/v3 models; `Agent-harness` is the default model; the selector shows exactly those ids.

**Non-Goals:**
- Embedding the LiteLLM dashboard in a same-origin iframe (the `/ui` SPA has an interactive sign-in flow that token-injection cannot satisfy - keep the open-in-new-tab link, per the existing `litellm-web` spec).
- Re-implementing the OpenConnector or LiteLLM native UIs.
- Changing the documents RAG provider (it uses Volces *coding/v3* directly via `VOLCES_BASE_URL`/`VOLCES_API_KEY` - unchanged).
- Persistent multi-key rotation UI in LiteLLM admin (rotation is configured statically in `litellm.yaml`).

## Decisions

### D1: New-chat navigates client-side (bug 1)
The Sidebar's "+ New" handler will call `navigate("/chat")` (react-router `useNavigate`) in addition to `send({ type: "new_session" })`. The server already creates the session and broadcasts `session_changed`/`session_loaded`; the store already handles those. No server change needed.
- *Alternative considered*: have the server drive navigation via a WS event. Rejected - navigation is a client concern and the SPA already owns routing.

### D2: Rebuild the OpenConnector web console so `dist/web/assets/*` is populated (bug 2)
Re-run the OC build (`scripts/build-openconnector.js`, specifically the `npm run build:web` step + the `dist/web` copy) so `resources/openconnector/dist/web/assets/` contains the hashed JS/CSS the `index.html` references. Audit the copy logic (lines ~120-125, `SKIP_DIRS`/`TOP_LEVEL_SKIP_DIRS`) to confirm `assets/` is not erroneously skipped. The runtime's catch-all returning `index.html` for missing assets is expected SPA behavior; the fix is supplying the assets, not patching the runtime.
- *Alternative considered*: proxy-rewrite the OC HTML's absolute `/assets/*` refs to `/oc-web/assets/*`. Rejected - the runtime still has no asset files to serve; rewriting only changes which path 404s.

### D3: Surface the reachable LiteLLM API base URL + master key (bug 3)
Extend `/api/litellm/credentials` (`server.js:919`) to also return `apiBaseUrl: LITELLM_BASE_URL` when LiteLLM is local (same `isLocal` gate already used for `masterKey` - no new key exposure: the base URL is not a secret and is already derivable from `litellmManagementUrl`). Update `LiteLLMPage` (`EmbeddedServicePages.tsx`) to display `apiBaseUrl` as a copyable field next to the master key, so the user has a direct API endpoint (`${apiBaseUrl}/v1/...`, bearer `masterKey`). The dashboard link already works.
- *Alternative considered*: add `apiBaseUrl` to `/api/config`. Rejected as the primary channel - `/api/litellm/credentials` already gates key exposure on `isLocal` and is the right place for API-access info; `/api/config` stays limited to the management URL + enabled flags.

### D4: Re-seed the LiteLLM proxy config with `Agent-harness` + the four plan/v3 models (bug 4)
Rewrite **both** the template `resources/litellm/default-config.yaml` **and** the live `litellm.yaml` (CWD) `model_list` to:
- `Agent-harness` -> `openai/glm-5.2` (two deployments, one per key, for rotation - LiteLLM router load-balances identical `model_name`s).
- `doubao-seed-2-0-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2` -> `openai/<id>`, each with two deployments (one per key).
- `api_base: os.environ/VOLCES_PLAN_BASE_URL` (set to `https://ark.cn-beijing.volces.com/api/plan/v3`), `api_key: os.environ/VOLCES_PLAN_KEY_1` / `VOLCES_PLAN_KEY_2`.
- Remove `volces-coding`, `volces-coding-plan-v3`, and the coding/v3 `deepseek-v4-pro` from `model_list` (documents RAG uses Volces directly, not via the proxy, so it is unaffected).
- `master_key: os.environ/LITELLM_API_KEY` (unchanged).

Wire the new env vars into the LiteLLM child process: `supervisor/descriptors.js` (which already builds the litellm env at ~line 144) passes `VOLCES_PLAN_BASE_URL`/`VOLCES_PLAN_KEY_1`/`VOLCES_PLAN_KEY_2` through from the launcher env; the keys originate in `.env` (gitignored) / `dev-settings.json` (gitignored). Set `DEFAULT_MODEL=Agent-harness` in `.env`. Because the selector fetches `/v1/models`, it will show exactly the five `model_name`s once the proxy reloads the new config; `resolveDefaultModel()` resolves `DEFAULT_MODEL=Agent-harness` to the registered alias.
- *Alternative considered*: hardcode the keys directly in `litellm.yaml`. Rejected - violates the existing `os.environ/` pattern and would commit secrets (the template is checked in).
- *Alternative considered*: keep one key, skip rotation. Rejected - the user explicitly provided two keys for rotation.

### D5: Apply live config without a full rebundle
For the running dev server, the `litellm.yaml` edit + a LiteLLM process restart (the supervisor restarts the child on config change, or `npm start` restart) is enough for bug 4; bugs 1 and 3 need `npm run web:build` (or `web:dev`) to pick up the React changes; bug 2 needs `scripts/build-openconnector.js` re-run. Tasks will call these out explicitly.

### D6: Synthesize a ModelInfo for LiteLLM aliases the SDK registry drops (bug 4)
The `pi-provider-litellm` extension registers models from `/model/info` but the SDK modelRegistry dedupes custom aliases that share an upstream model with a catalog entry - so `Agent-harness` (-> `openai/glm-5.2`) never lands in the registry, even though `/v1/models` and `/model/info` list it and LiteLLM routes it. To make `Agent-harness` both the startup default and runtime-switchable, `server.js` synthesizes a minimal `ModelInfo` (`{ id, name, provider: "litellm" }`) in two places when the id is a valid LiteLLM model_name but not in the registry: `resolveDefaultModel()` (so `DEFAULT_MODEL=Agent-harness` starts the agent on it) and `switchModelTo()` (so selecting it from the dropdown switches to it). LiteLLM routes by `model_name` at request time, so the synthetic model resolves correctly. Verified: `current_model=Agent-harness` on connect; `set_model Agent-harness` (from a different current model) broadcasts `model_changed`; a chat completion to `Agent-harness` reaches the Volces plan/v3 `glm-5.2` endpoint.
- *Alternative considered*: patch the extension to skip dedup. Rejected - the extension is a bundled `node_modules` dependency; patching is lost on reinstall.

## Risks / Trade-offs

- **[OC rebuild fragility]** The OC web build (`npm run build:web`) depends on the bundled OC source's devDeps (vite). If it fails again, dist/web stays incomplete. -> Mitigation: add a post-build assertion in `scripts/build-openconnector.js` that `dist/web/assets/` is non-empty (fail loud), and document the rebuild step in `tasks.md`.
- **[Second key validity]** `17753221425` does not look like a standard Volces `ark-...` key. If it is invalid, the rotation will route some requests to a failing deployment. -> Mitigation: use both keys as requested (rotation) but note in tasks that the user should verify both keys work; LiteLLM router retries across deployments so a single bad key degrades rather than breaks.
- **[Dynamic LiteLLM port]** The API base URL surfaced to the user is only valid for the current process lifetime (the port changes if 4000/free-port selection shifts). -> Mitigation: the URL is fetched live from `/api/litellm/credentials` (which reads the current `LITELLM_BASE_URL`), so it always reflects the running proxy; document that the URL is process-scoped.
- **[Stale `.env` LITELLM_BASE_URL=4000]** Harmless (launcher overrides) but confusing. -> Mitigation: optionally update `.env` to remove the stale value / document that the launcher manages it.
- **[Spec already requires LiteLLM-only selector]** The `model-selection` spec already mandates LiteLLM-only when configured; bug 4 is a config fix, not a spec behavior change for the selector itself. The spec delta is limited to the *default model = Agent-harness* requirement.

## Migration Plan

1. Rebuild OC resources (`scripts/build-openconnector.js`) - restores the OpenConnector page immediately, no runtime config change.
2. Edit `litellm.yaml` + `resources/litellm/default-config.yaml` + `.env` (keys, `DEFAULT_MODEL=Agent-harness`, `VOLCES_PLAN_*`); restart LiteLLM child - restores the correct model set.
3. Edit `server.js` (`/api/litellm/credentials` `apiBaseUrl`) + `Sidebar.tsx` (navigate) + `EmbeddedServicePages.tsx` (show API URL); `npm run web:build` - restores new-chat nav + LiteLLM API surface.
4. Verify each via the live server (curl + browser): new-chat from /documents lands on /chat; OC iframe shows the runtime UI; LiteLLM page shows API URL + key and the dashboard link opens; selector lists the 5 models with `Agent-harness` default.

**Rollback**: revert the `litellm.yaml`/default-config to the coding/v3 models, revert the three source edits, rebuild web + OC. No data migration; `dev-settings.json`/`litellm.yaml` are regenerated on first run if deleted.

## Open Questions

- **RESOLVED**: `17753221425` is NOT a valid Volces plan/v3 key (direct probe: `401 - The API key format is incorrect`). It looks like a phone number. `VOLCES_PLAN_KEY_1` is set to the valid `ark-1e510caf-...` key (same as `KEY_2`) so rotation uses a working key; the user should replace `KEY_1` with a real second key if they want genuine two-key rotation.
- **RESOLVED during verification**: the valid `ark-1e510caf-...` key authenticated successfully but the account hit its 5-hour Volces quota (`429 AccountQuotaExceeded`, resets 2026-07-25 05:47 CST). Routing + auth are correct; chat completions will succeed once the quota resets. Not a config issue.
- Should the stale `.env` `LITELLM_BASE_URL=http://localhost:4000` be removed? (Lean: leave it - the launcher overrides it - but document.)
