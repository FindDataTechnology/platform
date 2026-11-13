## Why

The hardcoded model rosters no longer match the gateway reality. A 2026-09-30 probe of all 33 ids on `token.finddatatech.cloud/v1/models` (plus the in-cluster sub2api mirror) showed: `GET /v1/models` is a "recognized ids" list, not a "serving" list — only ~13 of 33 actually serve traffic. Meanwhile both rosters have rotted in opposite directions: `VOLCES_MODELS` (dsh-profile.js) carries ~12 dead ids (date-suffixed deepseek now `model_not_found`, kimi/minimax/qwen/seed/longcat ids absent from the gateway, `glm-5.3/5.2/5.1` not authorized for this account group, nex free tier revoked), while the live `finddata-token` provider record registers only 2 models. The user asked for the serving deepseek / glm / mimo families to be listed, with deepseek first and `deepseek/deepseek-v4.1-flash` as default.

## What Changes

- Refresh `VOLCES_MODELS` in `dsh-profile.js` from 22 entries to 13 probe-verified ids, ordered deepseek → glm → free pool (`:free` ids last within the free block). The header comment is rewritten to record the probe method and the account-group constraint.
- Refresh the user provider `finddata-token`'s `models` array (dev `llm-providers.json` and prod `/data/llm-providers.json`) to the same 13 entries, so the reserved env route and the managed provider no longer disagree.
- Reset the dev default pointer (`llm-default.json` + `.env` `DEFAULT_MODEL`) from `dots-studio/dots-3-note-preview:free` to `deepseek/deepseek-v4.1-flash` (the agreed rehearsal lane; see llm-gateway-config memory). Prod default already points there — untouched.
- Deduplicate the merged model list in `getAvailableModels()` (server/agent-session.js): when two provider rosters list the same model id, the first occurrence wins. Without this, overlapping rosters render duplicate dropdown rows with colliding React keys.
- Update `e2e/model-selection.spec.js` — the FROZEN id set (`deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`, `glm-5.2`) asserts dead ids and must track the new roster.

Excluded from the roster (probe evidence 2026-09-30): all 6 mimo ids (upstream "Service temporarily unavailable", retried), `glm-5.3/5.2/5.1` + bare `deepseek-v4.1-flash` + `kimi-k2.6` (account group not authorized), nex free tier (now paid), `nemotron-3.5-content-safety` (classifier, not a chat model). mimo recovery is handled by the companion change `add-llm-model-discovery`, which adds probe-driven sync so future drift self-heals instead of needing another manual change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `model-selection`: the "Server lists available models to the client" requirement gains a first-occurrence dedup guarantee for model ids shared across merged provider rosters (env route + user providers), keeping the client dropdown stable and React keys unique.

## Impact

- `dsh-profile.js` (`VOLCES_MODELS`), `server/agent-session.js` (`getAvailableModels`), `e2e/model-selection.spec.js`.
- Dev data files (gitignored): `llm-providers.json`, `llm-default.json`, `.env`.
- Prod data files (apply phase): `/data/llm-providers.json` on the platform pod + `/api/models/refresh` hot reload; no restart needed (dsh-settings-file / dsh-credentials-local hot-reload).
- `deepseek-v4-pro` probe-flapped on 2026-09-30 (authorized per the earlier 32768 verification, then "not supported" three times in a row minutes later). It stays on the roster with a comment; its flakiness is a gateway account-pool issue, not a roster issue.
