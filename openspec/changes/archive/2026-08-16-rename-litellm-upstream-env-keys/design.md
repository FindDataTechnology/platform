# Design — rename-litellm-upstream-env-keys

## Context

The bundled LiteLLM's upstream endpoint and credentials are delivered to the LiteLLM child process as environment variables. `litellm.yaml` reads them via `os.environ/<NAME>`. Today the names are `VOLCES_PLAN_BASE_URL`, `VOLCES_PLAN_KEY_1`, `VOLCES_PLAN_KEY_2`. They are produced/consumed in four places:

1. `supervisor/descriptors.js` — builds the LiteLLM child `env`, reading `agentEnv.VOLCES_PLAN_*` and defaulting the base URL to `https://ark.cn-beijing.volces.com/api/plan/v3`.
2. `electron/config/settings.js` — `SETTING_KEYS` + `resolveEnv()` (packaged app: settings.json wins over inherited env).
3. `local-services.js` — its own `SETTING_KEYS` pass-through loop (dev launcher).
4. `litellm.yaml` — `os.environ/VOLCES_PLAN_*` references in every model block.

`agentEnv` is the single hand-off point: both settings.js (Electron) and local-services.js (dev) produce it, descriptors.js consumes it. So the rename + legacy fallback is cleanly localized: forward new names, fall back to old names when building `agentEnv`/child env.

## Goals / Non-Goals

**Goals:**
- Provider-neutral env key names for the LiteLLM upstream.
- Existing `.env` / `settings.json` using the legacy names keep working (no forced migration).
- Single, obvious place that resolves "new name wins, else legacy name."

**Non-Goals:**
- Making the upstream dynamically reconfigurable beyond the env rename.
- Changing the baked `LLM_API_KEY` fallback in `electron/main.js` (separate concern).
- Renaming the direct (non-LiteLLM) provider id `volces` / display name in `server.js` (separate concern).
- Touching `LITELLM_MASTER_KEY` / `LITELLM_SALT_KEY` / `DATABASE_URL`.

## Decisions

**D1 — New names.** `LLM_UPSTREAM_BASE_URL`, `LLM_UPSTREAM_KEY_1`, `LLM_UPSTREAM_KEY_2`. Neutral, reads as "the upstream the proxy forwards to," consistent with the existing `LLM_API_KEY` / `LLM_BASE_URL` prefix family. Alternatives considered: `PROXY_UPSTREAM_*` (confusable with the LiteLLM proxy itself), `LITELLM_UPSTREAM_*` (ties the name to LiteLLM, which we may swap). Rejected.

**D2 — Fallback at the resolution boundary, not scattered.** Add a small resolver: for each key, value = `agentEnv[NEW] ?? agentEnv[OLD] ?? <default>`. Applied in `supervisor/descriptors.js` (child env construction). `electron/config/settings.js` and `local-services.js` add the new names to their `SETTING_KEYS` lists but keep the legacy names too, so both flow into `agentEnv` and descriptors picks the winner. New name takes precedence over legacy.

**D3 — Base-URL default stays, renamed.** The fallback default `https://ark.cn-beijing.volces.com/api/plan/v3` in descriptors.js stays (it's a value, not a name) but the env key that overrides it becomes `LLM_UPSTREAM_BASE_URL`. Optionally reword the inline comment to say "upstream" instead of "Volces."

**D4 — litellm.yaml uses new names.** The seeded default config references `os.environ/LLM_UPSTREAM_*`. Legacy-named `settings.json`/`.env` still work because descriptors injects both, and litellm.yaml only reads the new names — wait, no: if we inject only new names into the child env, a legacy `.env` must still populate them. That is exactly D2: descriptors reads legacy `agentEnv.VOLCES_PLAN_*` and writes them into the child env **as the new names** (`LLM_UPSTREAM_*`), so litellm.yaml only ever needs the new names. The child env carries only `LLM_UPSTREAM_*`.

## Risks / Trade-offs

- **Partial rename (old `.env` + new yaml)** → litellm child gets `LLM_UPSTREAM_*` populated from legacy `agentEnv` via D2, so it still resolves. Covered by the fallback.
- **Both names set with different values** → new name wins (D2 precedence); document this. No merge.
- **A user customized `litellm.yaml` to read `os.environ/VOLCES_PLAN_*` directly** → after rename the child no longer receives `VOLCES_PLAN_*`, so their custom yaml breaks. Mitigation: keep injecting the legacy names into the child env *as well* (pass-through both), so custom yamls referencing either name resolve. Cheap insurance — inject new + legacy.
- **Drift between the two `SETTING_KEYS` lists** → they already mirror each other; the change adds the same three names to both, keeping them in sync.

## Migration Plan

- No forced migration. New names take effect immediately for new configs; legacy names continue to resolve via fallback.
- Operator action (optional): rename keys in `.env` / `settings.json` at leisure. `.env.example` is updated to the new names so fresh setups start clean.
- Rollback: revert the rename; both names were accepted, so nothing is stranded.

## Open Questions

- None blocking. (D4's "inject both names" vs "inject only new" — defaulting to injecting both for maximum compat.)
