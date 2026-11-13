## Why

The redesigned React SPA has four user-facing regressions that block normal use of Platform:

1. **New chat doesn't navigate.** Clicking "+ New chat" in the sidebar while on a non-chat page (Documents, Dashboard, History, OpenConnector, LiteLLM) creates/activates a session but does not switch the view to the chat route, so the user stays on the current page.
2. **OpenConnector page is blank.** Despite `openconnectorEnabled: true` and the `/oc-web` reverse proxy being mounted, the `/openconnector` route does not render the embedded runtime UI.
3. **LiteLLM page won't open and the API is unreachable.** LiteLLM is healthy and `litellmEnabled: true` (the launcher correctly reports `http://localhost:53007/ui`), but the `/litellm` view does not present a working entry to the management UI, and the LiteLLM API URL surfaced to the user does not resolve to the running proxy.
4. **Wrong model set + no default alias.** The model selector lists the LiteLLM proxy's current models (`volces-coding-plan-v3`, `deepseek-v4-pro`, `volces-coding`) instead of the intended Volces plan/v3 models, and there is no `Agent-harness` default model. The LiteLLM proxy's model configuration (`litellm.yaml`) must be re-seeded with the desired models and an `Agent-harness` alias.

These block the primary chat + SaaS-actions + LLM-proxy workflow. The backend flags and proxies are largely correct; the failures are in the React routing layer and the LiteLLM proxy model config.

## What Changes

- **New-chat navigation**: the "+ New chat" sidebar action SHALL navigate to the chat route (`/chat`) and start a fresh session from any page, not only when already on the chat view.
- **OpenConnector page**: fix the `/openconnector` React route so the `/oc-web` `<iframe>` renders (and the "blocked" overlay does not false-fire) when `openconnectorEnabled` is true.
- **LiteLLM page + API**: fix the `/litellm` React route so it renders the open-in-new-tab management link to `litellmManagementUrl` (or a clear disabled placeholder), and ensure the server surfaces a reachable LiteLLM API base URL (the running proxy's port) for direct API use.
- **Model selector scope**: enforce the existing LiteLLM-only requirement so the selector shows exactly the ids reported by the LiteLLM proxy `/v1/models` and no native Volces ids.
- **Agent-harness default model**: reconfigure the LiteLLM proxy to serve the Volces plan/v3 models `doubao-seed-2-0-pro`, `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.2` (base URL `https://ark.cn-beijing.volces.com/api/plan/v3`, authenticated with the provided keys), register an `Agent-harness` model alias as the default, and set it as the agent's default model.

## Capabilities

### New Capabilities
<!-- None - all affected capabilities already exist. -->

### Modified Capabilities
- `app-navigation`: add a requirement that the "+ New chat" action navigates to the chat view from any page (the current spec only requires the new session to become active, not that the view switches).
- `litellm-web`: add a requirement that the server surfaces a reachable LiteLLM API base URL (matching the running proxy) for direct API use, and the LiteLLM view displays it alongside the master key.
- `litellm-provider`: add a requirement to seed the LiteLLM proxy with the `Agent-harness` alias (routing to `glm-5.2`) and the four Volces plan/v3 models, authenticated with the configured keys, so the proxy `/v1/models` reports the intended set.

> Note: `open-connector-web` and `model-selection` already specify the intended behavior (the `/oc-web` iframe + proxy; `DEFAULT_MODEL` override). Bugs 2 and 4 are therefore build/config fixes against existing requirements, not spec-level changes - bug 2 rebuilds the incomplete OC web assets; bug 4 re-seeds `litellm.yaml` and sets `DEFAULT_MODEL=Agent-harness`.

## Impact

- **Frontend (`web/src/`)**: sidebar new-chat handler (navigate to `/chat` on session create), `EmbeddedServicePages.tsx` / route components for `/openconnector` (iframe render + overlay fix) and `/litellm` (management link render).
- **Backend (`server.js`)**: `/api/config` shape (already exposes `litellmEnabled`/`openconnectorEnabled`/`litellmManagementUrl` - verify), LiteLLM provider registration + default-model resolution, `/litellm-web` and `/oc-web` proxy mounting.
- **Launcher / LiteLLM config (`scripts/start.js`, local-services bootstrap, `litellm.yaml`)**: seed the LiteLLM proxy model list with the Volces plan/v3 models + `Agent-harness` alias and the provided keys; ensure the seeded config persists and is loaded by the spawned proxy.
- **Config (`.env`, `dev-settings.json`)**: `DEFAULT_MODEL=Agent-harness`; LiteLLM base URL + key already injected correctly by the launcher (verify `LITELLM_API_KEY` reaches `server.js`).
- **Keys handling**: the two provided Volces plan/v3 keys are server-side secrets; they MUST NOT reach the browser (consistent with the existing tokens-never-reach-the-browser convention).
