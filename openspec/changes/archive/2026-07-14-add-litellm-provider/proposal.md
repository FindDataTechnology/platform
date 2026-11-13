## Why

The web chat currently exposes only the Volces (火山引擎) provider with three hardcoded models. The user already runs a self-hosted LiteLLM proxy at `http://192.168.1.4:4000` (verified working via `GET /v1/models`) that aggregates many upstream models, but this project cannot consume it. Models, keys, and routing are administered on the LiteLLM side via its official management UI; this project should simply discover and use whatever the proxy exposes, rather than hardcoding model lists or credentials. Wiring in the `pi-provider-litellm` extension lets the chat surface every model the proxy routes, with zero per-model config in this codebase.

## What Changes

- Add the `pi-provider-litellm` npm package (a Pi extension) and register it through the server's existing `extensionFactories` mechanism, creating a `litellm` provider whose models are auto-discovered from the proxy at startup (`/model/info`, falling back to `/v1/models`).
- Load configuration from `.env` so the extension's expected `LITELLM_BASE_URL` and `LITELLM_API_KEY` are actually present at runtime. Today `.env` is never loaded - `package.json` runs `node server.js` and reads `process.env` directly, so only the hardcoded Volces fallbacks work. Replace the existing non-standard `lite_llm_host` / `lite_llm_auth_bear` entries with the canonical variable names and a full base URL (scheme + host + port).
- Expose discovered `litellm` models in the web chat model selector by adding `"litellm"` to the server's `EXPOSED_PROVIDERS` set.
- Add `.env` to `.gitignore` so the API key is not committed (currently `.env` is not ignored).
- Add a convenience link in the web UI that opens the LiteLLM proxy's official management web (`/ui`) in a new tab, so models/keys/routes are administered there - not in this project.
- LiteLLM model/key/route management happens in LiteLLM's official admin UI (out of this project's code scope); this project only consumes the proxy's OpenAI-compatible `/v1` endpoint.

## Capabilities

### New Capabilities
- `litellm-provider`: Register a self-hosted LiteLLM proxy as a Pi provider via the `pi-provider-litellm` extension, discover its models at startup from an env-configured base URL + API key, expose them in the model selector alongside Volces, and link to the proxy's official management UI for administration.

### Modified Capabilities
<!-- No existing spec requirements change. Adding `litellm` to EXPOSED_PROVIDERS is configuration, not a requirement change to `model-selection` (which already says models are "scoped to the providers the server is configured to use"). -->

## Impact

- **Dependencies**: add `pi-provider-litellm` (peer-deps `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`, already satisfied) and `dotenv` for `.env` loading (alternatively switch the `start` script to `node --env-file=.env server.js` on Node ≥ 20.6).
- **Modified files**: `package.json` (deps + start script), `server.js` (load `.env`, add the litellm extension factory to `extensionFactories`, add `"litellm"` to `EXPOSED_PROVIDERS`), `.env` (canonical variable names + full base URL), `.gitignore` (add `.env`), `public/index.html` / `public/app.js` (management-UI link).
- **Runtime**: at startup the extension probes the LiteLLM proxy (5s timeout, 24h model cache at `~/.pi/agent/litellm-models.json`, `LITELLM_OFFLINE=1` to use the cache and skip the probe). The proxy must be reachable for first-run discovery.
- **Tools**: the extension can register LiteLLM MCP tools; the server's existing `tools` allowlist in `createAgentSession` controls exposure, so no litellm tools appear unless explicitly allowlisted.
- **No breaking changes** to existing Volces chat behavior; the litellm provider is additive.
