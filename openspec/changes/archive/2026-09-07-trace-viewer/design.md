# Design — trace-viewer

## D1. Capture at the pump, not from disk

Three candidate sources were evaluated:

| Source | Verdict |
|---|---|
| dsh's persisted `session.jsonl.zstd` | Rejected: zstd-compressed dsh-internal format, no stable contract, no query RPC on the SDK server (dispatch table is `initialize`/`session/prompt`/`shutdown`), path layout (`~/.dsh/sessions/<cwd-slug>/…`) is an implementation detail |
| New SDK client subscription per turn | Rejected: `subscribe()` is process-global; the existing `#pump()` in dsh-bridge.js already fans every notification to `handleDshEvent` |
| Tap inside `handleDshEvent` | Chosen: one function call at the top, sees 100% of events in wire order, zero dsh internals touched |

```js
// server/dsh-events.js — the whole integration
ctx.handleDshEvent = (notif) => {
  trace.record(notif, { sessionId: ctx.dshSessionId, turnId: ctx.dshCurrentTurnId });
  ... existing switch ...
};
```

## D2. Schema (one table, JSON payload)

```sql
CREATE TABLE trace_events (
  id INTEGER PRIMARY KEY,
  turn_id TEXT NOT NULL,      -- durable message id returned by prompt()
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,       -- per-turn monotonic (host-assigned)
  ts INTEGER NOT NULL,        -- Date.now() at receipt
  method TEXT NOT NULL,       -- 'session.event' | 'session.status' | bridge.synthetic
  event_type TEXT,            -- ev.type ('turn/start', 'tool/call', …) when present
  payload TEXT NOT NULL       -- JSON.stringify(params)
);
CREATE INDEX idx_trace_turn ON trace_events(turn_id);
```

No typed columns per event kind — the event zoo (verified in a real session log: `request/header`, `request/context`, `llm/retry`, `llm/retry-started`, `step/start|end`, `agent/inbox/spliced`, `session/title*`, `approval/policy`, …) is open-ended and upstream-owned. Derivation happens at READ time (`summarizeEvent()` in trace.js), so adding rendering for a new event type never needs a migration. Writes are batched with a small in-memory queue flushed on a 500ms timer (or 200 rows) so a streaming turn doesn't hammer SQLite per-delta; flush forced on `turn/end` and `done`.

Turn lifecycle: the WS `prompt` handler stores the id `dshBridge.prompt()` resolved with into `ctx.dshCurrentTurnId`; `turn/start` (or the first event after a prompt) binds rows to it. Rows for unknown/bridge events get `event_type` from the method. A turn's duration = last ts − first ts.

## D3. API + UI

- `GET /api/trace/turns?limit&offset&sessionId` — derived turn summaries (GROUP BY turn_id: started, duration_ms, event_count, has_error from any error-kind event, model/provider scraped from the first `request/header` in the turn).
- `GET /api/trace/turns/:id` — ordered events, each `{ seq, ts, event_type, summary, payload }`; `summary` is a one-line human string for known types, raw for unknown.
- Frontend `/trace` (list; filters: session, errors-only) and `/trace/:turnId` (timeline: sticky left rail of ts+type, expandable JSON; derived groupings rendered as sections — LLM calls, tool calls with paired durations, delta aggregates as counts+sizes rather than replayed text). Static fetch via existing REST pattern (`trace-api.ts` mirrors `documents-api.ts`). No WS involvement — trace is read-after-the-fact by design.
- Entry points: Sidebar nav; later (out of scope) a link from a chat turn.

## D4. Failure isolation & retention

- `trace.record()` wraps everything in try/catch — a broken trace must never break a chat turn (graceful-degradation convention).
- `initTrace()` creates the table (idempotent) and prunes `ts < now − TRACE_RETENTION_DAYS` (default 14) on boot.
- Auth: routes follow the existing `/api/*` posture (no extra gate under `AUTH_MODE=none`; under `forward_auth` they're behind the proxy like every other `/api` route).

## Alternatives rejected

- **Full event log WS broadcast to the browser** — doubles streaming load for a diagnostic feature used occasionally; REST-after-the-fact is enough.
- **Reusing chat-history's message blocks** — they're already flattened/lossy (tool args parsed, no timing, no retries); trace needs the raw stream.
- **ClickHouse/otel** — one SQLite table is orders of magnitude below that threshold.
