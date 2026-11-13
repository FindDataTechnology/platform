## Why

Today `server/dsh-events.js` translates only 6 of the dsh event types (`turn/start`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `turn/end`) onto the frozen WS chat protocol and silently discards the rest (debug-log only). Yet the dsh runtime emits a rich append-only event stream — `request/header` (provider/model/effort/cost context), `request/context`, `llm/retry`, `step/start|end`, `agent/inbox/spliced`, `session/title-llm-request`, timing and token data — the same raw material the official dsh web UI renders as a per-turn trace. The pump in `dsh-bridge.js` already delivers every notification to `handleDshEvent`; we just throw the diagnostic-grade events away. Users debugging slow turns, retries, tool behavior, or token spend have nothing to inspect beyond the flattened chat transcript.

dsh persists this stream itself (`~/.dsh/sessions/<cwd-slug>/<sessionId>/session.jsonl.zstd`), but the SDK server exposes NO query RPC (dispatch table: `initialize`, `session/prompt`, `shutdown` only) and the log is zstd-compressed — reading it back means decompressing dsh-internal files on disk. The lazy, reliable channel is the one we already hold: **capture at the notification pump and persist to our own SQLite**.

## What Changes

- New `server/trace.js`: a tap inside `handleDshEvent` that writes every dsh `session.event` + `session.status` notification (raw `params`, monotonic per-turn seq, wall-clock timestamp, session id, turn id) to a new SQLite table. Failure-isolated: a trace write error logs and never breaks the turn.
- Turn correlation: the prompt WS handler already receives a durable message id from `dshBridge.prompt()`; that id (plus session id) keys the turn. Trace rows carry it so a turn's events group without parsing.
- New read API: `GET /api/trace/turns` (paginated list: turn id, session, started, duration, model/provider, tool count, error flag) and `GET /api/trace/turns/:id` (full ordered raw events, with derived per-event summaries for the common types).
- New frontend page `/trace` + `/trace/:turnId`: list view of turns; detail view renders the ordered event timeline with collapsible raw-JSON per event, plus derived sections the raw stream gives us for free — LLM call segments (header/context/retry/finish), tool calls (call/result pairing, durations), thinking vs text deltas (aggregated, not streamed), token/usage summaries when present in `finish` chunks.
- Sidebar gains a "Trace" nav entry. No WS protocol changes.
- Retention: prune trace rows older than N days (default 14) on boot; env knob `TRACE_RETENTION_DAYS`.

## Capabilities

### New Capabilities
- `turn-tracing`: capture, persistence, querying, and UI rendering of the full per-turn dsh event stream.

## Impact

- **Backend**: new `server/trace.js` (tap + store + prune), `server/dsh-events.js` (one tap call at the top of `handleDshEvent`), `server.js` (two REST routes), `db.js` (new table + migration).
- **Frontend**: new `web/src/pages/TracePage.tsx`, `web/src/lib/trace-api.ts`, Sidebar nav entry, chat store untouched, locales ×5.
- **No new dependencies.** Storage volume: one row per event; a heavy turn is hundreds of rows of small JSON — SQLite handles this trivially; retention bounds growth.
- **Known ceiling (ponytail)**: no backfill from dsh's own `.jsonl.zstd` logs — trace starts capturing from deploy forward; historical turns have no trace. No per-event filtering UI in v1 (raw + derived views only).
