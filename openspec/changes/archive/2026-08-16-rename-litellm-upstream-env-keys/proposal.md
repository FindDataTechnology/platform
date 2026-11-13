# rename-litellm-upstream-env-keys

## Why

The bundled LiteLLM upstream is configured via env keys named `VOLCES_PLAN_BASE_URL`, `VOLCES_PLAN_KEY_1`, and `VOLCES_PLAN_KEY_2`. These names are baked into `litellm.yaml`, the Electron settings pass-through (`electron/config/settings.js`), and the dev launcher (`local-services.js`), and they leak into the packaged app's `settings.json`. The `VOLCES_` prefix makes the product look locked to one specific provider (火山引擎/Volces), even though the upstream is just an OpenAI-compatible endpoint. Renaming to provider-neutral keys keeps the project vendor-agnostic and avoids implying a required provider.

## What Changes

- **Rename** the three upstream env keys to provider-neutral names:
  - `VOLCES_PLAN_BASE_URL` → `LLM_UPSTREAM_BASE_URL`
  - `VOLCES_PLAN_KEY_1` → `LLM_UPSTREAM_KEY_1`
  - `VOLCES_PLAN_KEY_2` → `LLM_UPSTREAM_KEY_2`
- Update `litellm.yaml` (the seeded default LiteLLM config) to reference the new `os.environ/LLM_UPSTREAM_*` names in every model block.
- Update the pass-through key lists in `electron/config/settings.js` and `local-services.js` so the new names are forwarded to the LiteLLM child process.
- **Backward compatibility:** the launcher/settings resolution accepts the legacy `VOLCES_PLAN_*` names as a fallback when the new names are absent, so existing `.env` / `settings.json` deployments keep working unchanged.
- Update `.env.example` / docs comments to use the new, provider-neutral names.

This is a config-naming change only. It does **not** make the upstream dynamically reconfigurable beyond an env rename, does **not** change the baked `LLM_API_KEY` fallback, and does **not** touch the direct (non-LiteLLM) provider id `volces` in `server.js` — those are separate concerns.

## Capabilities

### New Capabilities
- `litellm-upstream-config`: how the bundled LiteLLM's upstream endpoint + credentials are named, resolved, and passed through (new names + legacy fallback).

### Modified Capabilities
- (none — no existing spec declares these env key names; behavior is unchanged apart from the accepted names.)

## Impact

- `litellm.yaml` — env references renamed.
- `electron/config/settings.js` — pass-through key list.
- `local-services.js` — pass-through key list + legacy-fallback resolution.
- `.env.example`, `README.md` / `DEPLOY.md` comments — naming/documentation.
- Existing operator `.env` / packaged `settings.json` using the old names — preserved via fallback.
