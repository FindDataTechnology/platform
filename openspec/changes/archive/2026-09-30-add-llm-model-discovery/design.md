## Context

See proposal.md — Why. The Models page already manages user providers (`llm-providers.js` CRUD, `/api/llm/providers*`, hot-reload via `reloadLlmProviders` → `writeLlmProfile` → dsh settings-file watch). `testProvider` already GETs `<baseUrl>/models` and discards the body; the credentials and sanitize-error plumbing this design needs therefore exist. The 2026-09-30 probe session (33 ids × 1-token completions) established both the error-shape taxonomy and that ~8s sequential probing ×33 is fine, but parallel-to-33 is what we must avoid.

## Goals / Non-Goals

**Goals:**
- One admin action that reconciles a provider's model roster with what actually serves traffic.
- Per-id status visibility (serving / unauthorized / upstream_down / rate_limited / not_chat / error) on the Models page.
- Keep verified metadata (deepseek 32768 + efforts, etc.) authoritative from code, not from probes.

**Non-Goals:**
- Scheduled/automatic sync (manual only; cron is out of scope).
- Discovering metadata from the gateway — it publishes none; the family-mapping table stays hand-maintained.
- Pricing/quota discovery.
- Multi-key rotation or per-account probing inside one gateway.

## Decisions

**D1 — Probe = one 1-token chat completion per id, not a models-list parse.**
The list endpoint cannot distinguish serving from recognized (that's the whole premise). A `max_tokens: 1` completion with "只回复ok" answers in ~1–3s on serving ids. Alternative rejected: probing only ids we're about to add — no, statuses for *absent* ids (mimo upstream_down) are exactly the operator signal we want.

**D2 — Classification by error-text shape, HTTP code first.**
- HTTP 200 with a `choices[]` entry → `serving` (even `finish_reason: length`; `nemotron-3.5-content-safety` returns 200-with-empty-content → `not_chat` when content is empty/whitespace AND finish is `length` or content is missing).
- Message contains "not supported by any configured account" (404/400 family) → `unauthorized`.
- "Service temporarily unavailable" / "Upstream service temporarily unavailable" (503 family) → `upstream_down`.
- "rate limit" (429 family) → `rate_limited`.
- Else → `error` with sanitized message.
Text matching is on normalized substrings; the exact gateway strings are recorded in the mapping table next to the code, one place to update. Alternative (structured error codes) rejected: the gateway doesn't emit machine-readable classes.

**D3 — Bounded concurrency 4, per-probe timeout 30s, one retry for `rate_limited`/network errors only.**
33 ids ≈ 25–60s total worst case; the sync request is a single long-lived HTTP response streaming nothing (simple await) — the UI shows a spinner + count. Alternatives: WS progress events (nice-to-have, deferred); sequential (3–4min, too slow for an operator action).

**D4 — Sync result merges `serving` ids into `provider.models` (append new, keep existing entries' hand-tuned fields), stores `{ id → status, error?, probedAt }` in a `discovery` map on the provider record, and does NOT delete non-serving entries that are already in `models`.**
Deleting would fight the observed flappiness (`deepseek-v4-pro` flipped states within minutes). Non-serving roster entries are flagged in the UI (warning chip) instead of removed. `serving` ids missing from the roster are appended with family-table defaults (128k/8192/no-efforts unless the family says otherwise). Removal stays a manual edit.

**D5 — Family-mapping table in code (`llm-providers.js`), keyed by id-prefix, ordering-aware.**
`deepseek*` → 32768 + reasoningEfforts (matches `declaredEfforts`), `glm-5.3-flash` → 32768, default → 128k/8192/none. Same table drives post-sync ordering: family rank deepseek → glm → mimo → rest → `:free`, then id. This keeps "deepseek lane first" true after any sync. Alternative (persisting order in the JSON) rejected: order is policy, policy lives in code.

**D6 — Reserved `volces` route: dry-run only.**
`POST /api/llm/providers/volces/sync` classifies and returns what would change; applying is a code change (the roster is `VOLCES_MODELS`). The route is env-owned and its record isn't in the store, so mutation has no home anyway. UI shows the dry-run result read-only.

**D7 — Sync runs through the existing write lock + hot-reload path.**
Classification (network) happens BEFORE acquiring `tryWithWriteLock`; only the merge + `reloadLlmProviders()` run inside it. A second concurrent sync is a 409 like any other edit. Crash mid-probe leaves nothing half-written.

**D8 — Security: probe requests go provider→its own baseUrl with its stored key** — the same trust boundary as a normal chat turn; no new egress. Errors pass through the existing `sanitizeError` (key redaction, 200-char cap) before persisting into the `discovery` map, which is client-visible.

## Risks / Trade-offs

- **Probe cost**: ~33 × 1-token completions per sync, manual. Negligible today; if the gateway grows, the concurrency cap keeps it bounded.
- **Error-text fragility**: gateway wording changes break classification → everything lands in `error` with the raw (sanitized) message; statuses degrade to "look at the message", never to wrong `serving`. The failure mode is informative, not silent.
- **Flapping models** (`deepseek-v4-pro`): a sync is a snapshot; D4's no-delete rule means a bad minute doesn't evict a good model. Trade-off: a genuinely dead id lingers flagged until manually removed.
- **not_chat heuristic**: empty-content + `finish_reason: length` could theoretically mark a slow-but-fine model as not_chat on a 1-token budget. Consequence is bounded: `not_chat` ids are flagged and NOT merged, and the operator can still add one manually via the existing edit form.
- **Long-running HTTP request**: a 60s sync holds one server connection; fine for an admin action, documented as such.
