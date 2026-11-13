## Context

`server.js` builds the Pi agent from `@earendil-works/pi-coding-agent` as a library. It creates an `AuthStorage` + `ModelRegistry`, then a `DefaultResourceLoader` whose `extensionFactories` array currently contains one factory that calls `pi.registerProvider("volces", …)` with a hardcoded model list. `createAgentSession` is then wired with `modelRegistry`, `resourceLoader`, and a `tools` allowlist. The model selector on the client is driven by `EXPOSED_PROVIDERS = new Set(["volces"])`: the `list_models` WS handler filters `modelRegistry.getAvailable()` to that set, and `set_model` resolves a model by id within the same set.

Configuration today is read directly from `process.env` (e.g. `VOLCES_API_KEY`) with hardcoded fallbacks. `package.json` runs `node server.js` - there is no `dotenv` and no `--env-file` flag, so the existing `.env` is never loaded; only the hardcoded Volces fallbacks keep the server working. `.env` currently holds `lite_llm_host=192.168.1.4` and `lite_llm_auth_bear=sk-…` (non-standard names, host without scheme/port), and `.env` is **not** in `.gitignore`.

A self-hosted LiteLLM proxy is reachable at `http://192.168.1.4:4000` (verified: `GET /v1/models` with the bearer key returns the model list). LiteLLM exposes an OpenAI-compatible `/v1` endpoint plus a built-in management UI at `/ui`. The `pi-provider-litellm` npm package (v1.2.9) is a Pi extension whose default export is `async (pi: ExtensionAPI) => Promise<void>` - exactly the factory shape already used by the volces factory. It discovers models via `/model/info` (falling back to `/v1/models` then `/health`), caches them for 24h at `~/.pi/agent/litellm-models.json`, and reads `LITELLM_BASE_URL` / `LITELLM_API_KEY` from the environment (falling back to stored credentials in `~/.pi/agent/auth.json`).

## Goals / Non-Goals

**Goals:**
- Register the LiteLLM proxy as a Pi provider named `litellm` with zero hardcoded model list - models come from the proxy.
- Make `.env` actually loaded at startup so the extension's expected env vars are present.
- Surface discovered litellm models in the existing model selector and allow runtime switching to them.
- Provide a link from the web UI to LiteLLM's official management UI (`/ui`) for administering models/keys/routes.
- Keep the LiteLLM API key out of version control.

**Non-Goals:**
- Building custom model/key/route management UI in this project - administration happens in LiteLLM's official management web.
- Enabling the extension's LiteLLM MCP tools or Skills Gateway prompt injection in this change (gated by the `tools` allowlist; can be enabled later).
- Replacing or removing the existing Volces provider.
- Changing the existing `model-selection` requirements (adding a provider is configuration, not a spec-level behavior change).

## Decisions

### D1: Use the `pi-provider-litellm` extension via `extensionFactories` (not a hand-rolled `createProvider`)
The project already registers providers through `DefaultResourceLoader`'s `extensionFactories` (`pi.registerProvider`). The litellm package's default export is the same factory shape, so it drops in as `litellmExtension` alongside the volces factory. The extension already implements discovery, 24h caching, compat handling, and auth - duplicating this with `createProvider` + `openAICompletionsApi` and a static model list would break whenever the proxy's model set changes.
- *Alternative considered:* hand-roll a `createProvider({ baseUrl, api: openAICompletionsApi(), models: [...] })`. Rejected - requires maintaining model IDs and loses auto-discovery.

### D2: Load `.env` with `dotenv` (not `node --env-file`)
`import 'dotenv/config'` as the first statement in `server.js` populates `process.env` before the agent initializes. Works on any Node version, is the conventional pattern, and degrades gracefully if `.env` is absent.
- *Alternative considered:* switch `start` to `node --env-file=.env server.js` (Node ≥ 20.6). Simpler (no dep) but hard-fails when `.env` is missing, requires a Node-version gate, and offers no benefit over `dotenv` here.

### D3: Canonical env var names (`LITELLM_BASE_URL`, `LITELLM_API_KEY`)
Replace `.env`'s `lite_llm_host` / `lite_llm_auth_bear` with `LITELLM_BASE_URL=http://192.168.1.4:4000` and `LITELLM_API_KEY=sk-…`. These are the exact names the extension reads; the current `lite_llm_host` lacks scheme and port, so a mapping layer would have to hardcode `:4000` anyway.
- *Alternative considered:* keep `lite_llm_*` and map in code. Rejected - duplicates the port assumption and hides the real config name from anyone reading the extension docs.

### D4: Auth via env vars (extension's documented path); optional `setRuntimeApiKey` for parity
The extension resolves auth as: stored pi credential > `LITELLM_API_KEY` env. Env alone is sufficient and is the documented lowest-friction path. For parity with the volces factory (which uses `authStorage.setRuntimeApiKey`), the server MAY also call `authStorage.setRuntimeApiKey("litellm", LITELLM_API_KEY)`; this is verified at implementation time by switching to a litellm model and confirming a successful response.

### D5: Expose litellm models by adding `"litellm"` to `EXPOSED_PROVIDERS`
The existing `list_models` and `set_model` handlers already filter/resolve against `EXPOSED_PROVIDERS`, so adding `"litellm"` surfaces discovered models with no handler changes. Models carry `provider: "litellm"`, so they are distinguishable from Volces models in the selector.

### D6: Management-UI link via a `GET /api/config` endpoint
Add a small `GET /api/config` endpoint returning `{ litellmManagementUrl: "${LITELLM_BASE_URL}/ui" }` (omitted/empty when litellm is unconfigured). The web UI renders a link that opens it in a new tab. Deriving the URL from the server's configured base URL keeps a single source of truth.
- *Alternative considered:* hardcode the URL in the frontend. Rejected - drifts from server config.

### D7: Do not add litellm tools to the `tools` allowlist
The extension may register LiteLLM MCP tools, but `createAgentSession({ tools: [...] })` filters to the allowlist, so none appear unless explicitly added. This change leaves the allowlist as-is.

## Risks / Trade-offs

- **[Proxy unreachable at startup]** -> The extension's discovery has a 5s timeout (`LITELLM_DISCOVERY_TIMEOUT_MS`) and a 24h cache; `LITELLM_OFFLINE=1` skips the probe and uses the cache. First run with no cache and an unreachable proxy yields no litellm models (Volces still works); the server stays up.
- **[`.env` loaded too late]** -> `import 'dotenv/config'` MUST be the first import in `server.js`, before any module that reads `process.env`. Documented in tasks; ordering is enforced by placement.
- **[Extension depends on `~/.pi/agent/`]** -> It calls `getAgentDir()` for auth/settings/cache. The project already uses `getAgentDir()`, so the dir resolves; if absent, env-var auth still works.
- **[API key committed]** -> `.env` is added to `.gitignore`. It is not currently tracked by git, so no history rewrite is needed; if it later gets committed, `git rm --cached .env` is the remedy.
- **[Model-id collisions across providers]** -> `set_model` resolves by `id` via `.find()` within `EXPOSED_PROVIDERS`; if two exposed providers share an id, the first wins. This is a pre-existing latent issue (out of scope here); mitigated long-term by keying the client on `${provider}/${id}`.
- **[Extension auto-registers Skills prompt injection]** -> Additive to the system prompt and benign; does not add tools (gated by allowlist). Acceptable; can be revisited if it interferes.

## Migration Plan

1. `npm install pi-provider-litellm dotenv`.
2. Edit `.env` to canonical names + full base URL.
3. Add `.env` to `.gitignore`.
4. Patch `server.js`: `import 'dotenv/config'` first; import the extension; add it to `extensionFactories`; add `"litellm"` to `EXPOSED_PROVIDERS`; add `GET /api/config`.
5. Patch the web UI to render the management link from `/api/config`.
6. Start the server, confirm `list_models` returns litellm models, switch to one and send a prompt.
- **Rollback:** remove the extension import/factory and the `"litellm"` entry from `EXPOSED_PROVIDERS`; the server reverts to Volces-only with no other changes required.

## Open Questions

- D4: confirm whether `authStorage.setRuntimeApiKey("litellm", …)` is needed in addition to env vars (verify by switching to a litellm model at implementation time).
- Whether the user wants LiteLLM MCP tools / Skills Gateway enabled later (default: no).
