## 1. Dependencies & configuration

- [x] 1.1 `npm install pi-provider-litellm dotenv`
- [x] 1.2 Edit `.env`: replace `lite_llm_host`/`lite_llm_auth_bear` with `LITELLM_BASE_URL=http://<LAN-HOST>:4000` and `LITELLM_API_KEY=sk-<REDACTED — rotate if still valid>`
- [x] 1.3 Add `.env` to `.gitignore`
- [x] 1.4 Confirm `.env` is not tracked by git (`git check-ignore .env` returns the path; if already tracked, `git rm --cached .env`) — N/A: project is not a git repo; `.gitignore` entry added for when it becomes one

## 2. Server wiring (server.js)

- [x] 2.1 Add `import 'dotenv/config'` as the **first** statement in `server.js`, before all other imports
- [x] 2.2 Add `import litellmExtension from "pi-provider-litellm";`
- [x] 2.3 Add `litellmExtension` as the first entry in the `DefaultResourceLoader` `extensionFactories` array (before the volces factory)
- [x] 2.4 Read `LITELLM_BASE_URL` / `LITELLM_API_KEY` from `process.env`; if either is missing, `console.warn` and skip registration
- [x] 2.5 (D4, optional) Call `authStorage.setRuntimeApiKey("litellm", LITELLM_API_KEY)` alongside the existing volces call — resolved: omitted. The extension reads `LITELLM_API_KEY`/`~/.pi/agent/auth.json` directly (not the in-memory authStorage), so `setRuntimeApiKey` is ineffective for it. Env-based auth is the documented path; verified in 4.3.
- [x] 2.6 Add `"litellm"` to `EXPOSED_PROVIDERS`
- [x] 2.7 Add a `GET /api/config` endpoint returning `{ litellmManagementUrl: "${LITELLM_BASE_URL}/ui" }` (omit the field when `LITELLM_BASE_URL` is unset)

## 3. Web UI (public/)

- [x] 3.1 Fetch `/api/config` on page load
- [x] 3.2 Render a "LiteLLM Management" link that opens `litellmManagementUrl` in a new tab (`target="_blank"`, `rel="noopener noreferrer"`); hide it when the URL is absent
- [x] 3.3 Place the link near the model selector

## 4. Verify

- [x] 4.1 Start the server (`npm start`); confirm no startup errors and a `litellm` provider is registered
- [x] 4.2 Confirm `list_models` returns models with `provider: "litellm"` alongside the Volces models
- [x] 4.3 Switch the active model to a litellm model and send a prompt; confirm a streamed response (resolves D4 open question) - D4 resolved: env-based auth works (the proxy accepted our key and routed the request). Model switch + prompt forwarding verified. A full streamed *text* response was not obtained because the litellm proxy's **upstream** keys are placeholders (401 `Incorrect API key ... sk-your-***here` for gpt-4o-mini; `invalid x-api-key` for claude-sonnet-4). That is a litellm-side config issue to fix in the management UI, not an integration defect.
- [x] 4.4 Click the management link; confirm it opens `http://192.168.1.4:4000/ui` - `/api/config` returns `{"litellmManagementUrl":"http://192.168.1.4:4000/ui"}`
- [x] 4.5 Stop the proxy (or set an unreachable `LITELLM_BASE_URL`), restart the server; confirm it logs a warning and starts Volces-only without crashing - with cache moved aside and `LITELLM_BASE_URL` set to an unreachable port: logged `LiteLLM (litellm): discovery failed (Timed out after 5000ms); registering provider with no models.`, reached `Agent ready`, and `list_models` returned Volces-only.
