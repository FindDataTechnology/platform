---
name: fd-paas-manage-model
description: Manage the LLM models available to the PAAS (pi-web-chat) agent, end to end - add, list, remove, validate, and switch models on the self-hosted LiteLLM proxy (192.168.1.4:4000) and register or adjust them in server.js (the volces provider model list and the EXPOSED_PROVIDERS selector set). Use this skill whenever the user asks to add / remove / check / switch / expose / hide a model or provider, register a new model or provider, fix model routing, fix a model that isn't appearing in the chat selector, refresh the model list, or anything about which models the PAAS agent can use - even when they never say the word "manage" or "model". Covers the LiteLLM admin API (POST /model/new, /model/delete, GET /v1/models, /model/info), the LAN --noproxy gotcha, endpoint validation before registering, and the pi-extension 24h cache refresh.
---

# fd-paas-manage-model

Manage the LLM models available to the PAAS (pi-web-chat) agent, end to end. There are two places models live, and this skill is about touching them correctly and safely.

## Where models live in PAAS

1. **LiteLLM proxy** at `http://192.168.1.4:4000` (self-hosted, DB-backed, `STORE_MODEL_IN_DB=True`). The `pi-provider-litellm` extension auto-discovers models from here at startup and caches the list for 24h at `~/.pi/agent/litellm-models.json`. **This is where most "add a model" work happens** - via the proxy's admin API, not by editing code.
2. **The `volces` provider** hardcoded in `server.js` (`extensionFactories` → `pi.registerProvider("volces", …)`). A static model list pointing directly at the Volcengine Coding endpoint (`https://ark.cn-beijing.volces.com/api/coding/v3`). Edit this only when you want a model wired straight into the app, bypassing LiteLLM.

Which providers show in the chat's model selector is gated by `EXPOSED_PROVIDERS` (a `Set` near the top of `server.js`). Switching models is rejected while the agent is streaming (`isStreaming`).

## Use the bundled script for every proxy operation

`scripts/litellm_models.sh` exists because two things bite every single time:

- **The global `http_proxy`.** The shell exports `http_proxy=http://127.0.0.1:7892` (clash), and its `no_proxy` does **not** cover the LAN. So a bare `curl http://192.168.1.4:4000/…` is routed through clash and silently fails with `HTTP 000` - which looks exactly like a dead host. The script passes `--noproxy '*'` for LAN targets automatically. (For external endpoints it correctly keeps the proxy.)
- **The admin key must not leak.** The script loads `LITELLM_BASE_URL` / `LITELLM_API_KEY` from `PAAS/.env`, so the key never lands in shell history or command output.

```bash
S=PAAS/.claude/skills/fd-paas-manage-model/scripts/litellm_models.sh
$S list                                       # public model names (GET /v1/models)
$S info                                       # name \t upstream-model \t db-id (GET /model/info)
$S add <name> <upstream> <api_base> <api_key> # POST /model/new; prints model_id
$S delete <model_id>                          # POST /model/delete
$S delete-name <model_name>                   # look up by name, then delete
$S test <model_name> [prompt]                 # chat completion THROUGH the proxy (proves routing)
$S validate <api_base> <api_key> [model]      # hit an endpoint's /models (+ tiny chat) BEFORE registering
```

`add` auto-prefixes `openai/` when the upstream model has no `/` (meaning OpenAI-compatible). Pass a full spec like `anthropic/claude-…` to override. The `api_key` you pass to `add` is encrypted at rest by LiteLLM - the response echoes ciphertext, not the key.

## Workflows

### Add a model that lives on an OpenAI-compatible endpoint
1. **Validate first.** `$S validate <api_base> <api_key> <model>` - confirm `HTTP 200` and a real reply. Do not register a model you have not seen return a completion; a bad model id or key silently produces a model that 404s on every chat.
2. **Add.** `$S add <public-name> <upstream-model> <api_base> <api_key>` - registers on the proxy and prints the `model_id` (save it for later deletion).
3. **Confirm.** `$S list` shows the new name.
4. **Prove routing.** `$S test <public-name>` - runs a chat completion through LiteLLM → the upstream. This is the only check that actually proves end-to-end routing.
5. **Surface in chat.** See "Refresh the cache" below.

Public names: prefix to avoid collisions. The direct `volces` provider already exposes `deepseek-v4-pro` etc., so proxy models are named `volc-coding-<id>` to keep the selector unambiguous (the registry resolves by id and first-match wins on duplicates).

### Register a model directly in `server.js` (the volces provider)
Use this only when a model should bypass LiteLLM and hit Volcengine directly. In `server.js`:
- Add an entry to the `models: [ … ]` array inside `pi.registerProvider("volces", …)`, matching the existing shape: `id`, `name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`.
- The provider `apiKey` / `baseUrl` come from `VOLCES_API_KEY` / `VOLCES_BASE_URL` (env, with a hardcoded fallback in `server.js`).
- Adding a **brand-new provider** (not `volces`): register it in `extensionFactories`, add its name to `EXPOSED_PROVIDERS` (or it stays invisible in the selector), and wire its key via `authStorage.setRuntimeApiKey("<provider>", key)`. The `litellm` provider (gated by `litellmEnabled`) is the pattern to copy.
- Restart the server to pick up `server.js` changes.

### Refresh the cache so the chat actually shows new proxy models
The `pi-provider-litellm` extension caches the model list for 24h at `~/.pi/agent/litellm-models.json`. A freshly-added proxy model will **not** appear in the chat selector until that cache refreshes. Pick one:
- Restart the PAAS server (`npm start`) - the extension re-probes at startup, or
- Delete the cache (`rm ~/.pi/agent/litellm-models.json`) then restart.

### Remove a model
`$S delete-name <model_name>` (resolves the id, then deletes) or `$S delete <model_id>`. Then refresh the cache. If it was also hardcoded in `server.js`, remove that entry and restart.

## Conventions to preserve (from CLAUDE.md)
- **Graceful degradation** - adding a provider/model must not break startup when it's unreachable. Optional dependencies log a warning and the server keeps running.
- **Tokens never reach the browser** - API keys stay server-side (in `.env` / the proxy DB); proxy routes forward only documented fields, never arbitrary client keys/headers.
- **One agent session serves all clients** - a model change affects everyone, not a single connection.

## Common pitfalls
- **"Host unreachable" that isn't** - `curl` to the proxy returning `HTTP 000` is the global `http_proxy`, not a dead host. Use the bundled script (or `--noproxy '*'`).
- **`/model/new` returns 500 `Set 'STORE_MODEL_IN_DB=True'`** - the proxy must run with `STORE_MODEL_IN_DB=True` and a connected DB. It's enabled on this proxy; if pointing at a different proxy that lacks it, set the env var + restart (the DB at `/health/readiness` must report `db: connected`).
- **Model is on the proxy but missing from the chat selector** - stale 24h cache (refresh it); or the provider isn't in `EXPOSED_PROVIDERS`; or its id duplicates an already-exposed model (first match wins).
- **External endpoint validation fails through `--noproxy`** - `validate` only bypasses the proxy for LAN hosts; external HTTPS (e.g. `ark.cn-beijing.volces.com`) goes through clash as normal.
