# Design — dsh-llm-models-page

## Context

dsh-llm is the dsh runtime's LLM-management plugin. It already runs server-side: `dsh-profile.js` writes an OpenAI-compatible providers section to `$DSH_HOME/settings.yaml` on startup, and dsh-llm's `ctx.llm.discoverModels()` returns the model list that feeds `initDshAgent()`. The UI today is a sidebar `<select>` that lists the discovered models.

The change adds a real `/models` page that lists the configured providers, allows CRUD on them, tests live connections, and lets the user pick a default model. The dsh runtime has no live reload RPC — picking up `settings.yaml` changes requires restarting the dsh child, which is what `dshBridge.restart({ provider, model })` already does for the model-switch case today. We extend that to accept a `profilePatchPath` so provider changes can restart with a fresh profile.

## Goals / Non-Goals

**Goals**
- CRUD over the dsh LLM profile (add/edit/remove providers; test connection).
- Per-provider model list (sourced from `discoverModels()`).
- Default-model pointer (no dsh restart required).
- Test connection button with latency + error reporting.
- API keys never leave the server; `hasKey: true|false` is the only client-visible signal.

**Non-Goals**
- Cost dashboards, per-model rate limits, usage analytics.
- Multi-tenant LLM routing (one default per deployment, same as today).
- Custom adapters beyond the OpenAI-compatible shape.
- Per-model fine-tuning / LoRA config.

## Decisions

### D1: settings.yaml is patched, not rewritten

The current `dsh-profile.js` writes `settings.yaml` from env on every startup. We introduce a **patch layer**: a second file (`$DSH_HOME/settings.patch.yaml`) that holds only the user-driven edits. At startup, the merge order is: base file (regenerated from env) + patch file (user edits) → effective settings passed to dsh. This way:
- A user edit survives an env-driven regeneration of the base.
- The base remains the single source of truth for "what came from env".
- Rollback = delete the patch file (or stop writing it).

Alternatives considered:
- **Rewrite settings.yaml directly** — rejected: re-generation on every startup would clobber user edits.
- **Per-provider overlay files** — rejected: too many files; one patch file matches dsh's existing merge semantics.

### D2: dsh restart is the only reload path

dsh has no live reload RPC. Provider add/edit/delete triggers `dshBridge.restart({ profilePatchPath })` — same path as today's `set_model` on a new provider. The active chat session is persisted to disk by dsh and resumes after the restart; the user sees a brief "reconnecting" in the status row. The default-model pointer write does NOT restart dsh; it's read on the next session prompt.

The mutex that serializes edits (next decision) also serializes against the `set_model` WS path so a user clicking a model selector and a settings-page edit can't race.

### D3: In-process mutex for concurrent edits

Two UI users (or two tabs) clicking "Add provider" simultaneously could race on `settings.patch.yaml`. We hold a single async mutex (`p-queue` or hand-rolled) around write paths. A second concurrent write returns 409 with `{ error: "another edit in progress" }`. Reads are not serialized.

### D4: Test endpoint uses a lightweight GET probe

For OpenAI-compatible providers, the probe is `GET <baseUrl>/models` with `Authorization: Bearer <key>`. 5-second timeout. 2xx → success with latencyMs; non-2xx or timeout → failure with a sanitized error (truncated body, no key). This is the cheapest probe that proves the base URL is reachable AND the key is valid.

Alternatives considered:
- **`POST <baseUrl>/chat/completions` with a minimal request** — rejected: makes a real LLM call; expensive and noisy in logs.
- **`GET <baseUrl>/` (just the root)** — rejected: most providers don't serve a useful response at root; a 404 would falsely fail.

### D5: Default model pointer is a separate concept from "active model"

The runtime has one *active* model id (sent to dsh in the `initialize` handshake). It also has one *default* model id (the user-visible "what gets used next time I open a chat"). Today these are conflated: a model switch restarts dsh and sets the active model. The change separates them: the default pointer is a server-held field that survives restarts; the active model is the result of the last `set_model` call. The Models page writes the default pointer; the WS `set_model` call (still used for ad-hoc switching) updates the active model. On dsh restart, the active model defaults to the pointer.

### D6: API key never reaches the client

Three rules:
- `GET /api/llm/providers` returns `hasKey: boolean` only, never the key.
- `POST /api/llm/providers` requires the key in the body; `PUT` allows it to be omitted (omission = keep current).
- Logs and error messages never include the key. The Test endpoint's error message truncates the response body and strips the key if it appears anywhere.

### D7: Models page is its own route, not nested under Settings

The proposal puts Models in two places: top-level sidebar tab AND Settings menu. Both navigate to the same `/models` route — no separate Settings sub-page. This avoids duplicate state and keeps the URL simple.

## Risks / Trade-offs

- **Restart during a prompt → brief "reconnecting" UX** → Mitigation: the existing status row already handles this; we surface a toast "Settings updated" so the user knows what happened.
- **Patch file diverges from base** → Mitigation: a startup check logs a warning if a base value (e.g. `LITELLM_BASE_URL` from env) is also overridden in the patch; the user can resolve via UI or by deleting the patch key.
- **Test probe makes a real network request** → Mitigation: 5s timeout, no retries, errors are sanitized. Worst case: a slow proxy makes the UI spinner spin for 5s.
- **Per-user LLM routing not supported** → accepted limitation; v1 is single-tenant.
- **API key rotation** → Mitigation: the Edit form lets the user replace the key (empty field = keep). Rotation = Edit + new key + Save.

## Migration Plan

Single deployment, no flag. The patch file is introduced fresh; existing users with no patch get the same behavior as today (env-driven settings). Users who want to add a provider via the UI will create the patch on first save.

Rollback: delete the patch file, restart server. The dsh child falls back to the env-driven base.

## Open Questions

- Should the Models page be reachable as a deep-link from the sidebar footer model chip OR only from the Models tab? → **Decision**: both. The chip is a read-only display that navigates to `/models` on click.
- Should we expose "which dsh-llm plugins are loaded" as a separate diagnostic page? → **Out of scope** for this change; could be a follow-up.
- How do we handle the case where the user edits a provider that the active session was using? → **Decision**: edit triggers restart; the session resumes from disk with the new provider. We surface a "Switched to <provider>" toast.
