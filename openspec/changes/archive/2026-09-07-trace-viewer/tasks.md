## 1. Storage + capture

- [x] 1.1 `db.js`: `trace_events` table + indexes (idempotent migration)
- [x] 1.2 `server/trace.js`: `initTrace({ db })` (table ensure + boot prune, `TRACE_RETENTION_DAYS` default 14); `record(notif, { sessionId, turnId })` — per-turn seq, ts, method/event_type/payload JSON; batched writes (500ms / 200-row flush, forced on turn end); every path try/catch-isolated
- [x] 1.3 `server.js` prompt handler: stash the resolved prompt id as `ctx.dshCurrentTurnId` (cleared on `done`)
- [x] 1.4 Tap: first line of `handleDshEvent` calls `trace.record`; verify with `DSH_DEBUG` off that a live turn writes rows (query sqlite directly)

## 2. Read API

- [x] 2.1 `GET /api/trace/turns?limit&offset&sessionId` — grouped summaries: turn_id, session_id, started, duration_ms, event_count, has_error, model/provider (first `request/header` in turn)
- [x] 2.2 `GET /api/trace/turns/:id` — ordered `{ seq, ts, event_type, summary, payload }`; `summarizeEvent()` one-liners for known types (turn, chunk-kinds aggregated, tool call/result pairing, request header/context, retries, steps), raw fallback
- [x] 2.3 404 for unknown turn id; empty list (not error) when no traces exist

## 3. UI

- [x] 3.1 `web/src/lib/trace-api.ts` typed client (mirrors documents-api.ts)
- [x] 3.2 `/trace` list page: table of turns (time, session, duration, events, model, error badge), filters session + errors-only, pagination
- [x] 3.3 `/trace/:turnId` detail: ordered timeline, per-event collapsible raw JSON, derived sections (LLM calls w/ retries, tool calls w/ durations, delta aggregates as counts)
- [x] 3.4 Sidebar "Trace" nav entry + router routes + locales ×5 (`check:locales` green)

## 4. Verification

- [x] 4.1 Unit-ish self-check: feed a synthetic notification sequence through `trace.record`, assert rows + derived summaries (one runnable check per the repo's no-test-runner convention) — `DB_PATH=/tmp/t.db node server/trace.js`
- [x] 4.2 E2E (fast project): run a turn, `/trace` lists it, detail shows ≥ turn/start + tool or chunk events (`e2e/trace.spec.js`; plus a live-server run captured a real 34-event turn incl. request/header, llm/retry, step boundaries, and model/provider extraction)
- [x] 4.3 Retention check: insert a row older than the window, run prune, assert removed (covered by the self-check's retention assertion)
