## Why

`GET /v1/models` on the gateway returns 33 ids but only ~13 actually serve traffic — it is a "recognized ids" list, not a "serving" list, and it carries no metadata (contextWindow / maxTokens / reasoning support) that the platform's dsh profile needs per model. Today the only way to reconcile roster and reality is a manual probe session plus a hand-edited change (`refresh-llm-model-roster` is exactly that). Every gateway account-pool flap (mimo's whole family went dark, `deepseek-v4-pro` flipped serving→unauthorized→back within minutes on 2026-09-30) currently drifts the roster until someone notices dead entries in the UI dropdown.

## What Changes

- Add a **model sync** action per provider on the Models page: admin-triggered, it fetches `GET <baseUrl>/models` for the full id list, then probes each id with a bounded-concurrency 1-token chat completion to classify it.
- Classification taxonomy (per id): `serving` (probe completed with a choice), `unauthorized` ("not supported by any configured account" style 4xx), `upstream_down` ("Service temporarily unavailable" / "Upstream service temporarily unavailable"), `rate_limited`, `not_chat` (answers but is a classifier — completion without a usable assistant reply), `error` (anything else, message retained).
- Only `serving` ids are merged into the provider's model roster; the rest are stored on the provider record as a status map and surfaced in the Models page (visible but not selectable), so operators can see "mimo: upstream_down ×6" instead of wondering where mimo went.
- **Runtime model-list editing** (user requirement, 2026-09-30 deploy): `PUT /api/llm/providers/:id` SHALL accept a `models` array (add/remove/reorder entries, with optional per-entry maxTokens/contextWindow overrides), and the Models page exposes a per-provider model-list editor — the same hot-reload path applies. Roster changes must never require an image rebuild or pod surgery; the refresh-llm-model-roster rollout had to hand-edit `/data/llm-providers.json` + run `writeLlmProfile()` inside the pod precisely because this gap exists.
- Metadata (contextWindow / maxTokens / reasoningEfforts) still comes from a local family-mapping table maintained in code — the gateway exposes none; sync merges ids with the table's defaults (128k/8192, no efforts) when a family is unknown, and never invents metadata it cannot verify.
- Ordering after sync: family rank (deepseek → glm → mimo → others → `:free` last), then id, so the dropdown keeps the agreed shape (deepseek lane first) regardless of gateway listing order.
- The reserved env route (`volces`) is read-only: sync reports what discovery would change but applies nothing (its roster is code-owned).

Companion to `refresh-llm-model-roster` (the immediate manual fix); this change makes the next drift self-healing.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `llm-model-management`: new requirement — provider-scoped model discovery (fetch + probe + classify + merge), its admin-only trigger, per-id status persistence on the provider record, and the Models page's sync button with per-model status display.

## Impact

- `llm-providers.js`: sync/classify logic, status persistence in `llm-providers.json` records, family-mapping table.
- `server/routes/llm.js`: `POST /api/llm/providers/:id/sync` (admin-gated), reuses the existing hot-reload path (`reloadLlmProviders`).
- `web/src/components/llm/*`: sync button on ProviderCard, status chips per model, result summary.
- Security: probes send the provider's stored key to its own baseUrl only (same trust domain as a chat turn); probe errors are sanitized through the existing `sanitizeError` path; sync is admin-gated like every other config mutation.
- Load: one 1-token completion per id (33 today), bounded concurrency (~4), 30s per-probe timeout; sync is manual, never scheduled.
