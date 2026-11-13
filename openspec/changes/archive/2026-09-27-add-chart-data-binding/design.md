# add-chart-data-binding — design

## Context

The live upstream was probed read-only before this design (2026-09-27, direct on the tailnet). Facts that shape it, all observed:

- **`fd-open-data-mcp` v4.0.5** (`chengsi` NodePort 30899, no auth on that port; the public path enforces the registry bearer). 62 tools. Read tools: `read_series` (cache-only) returns `{concept_id, entity_type, entity_id, start, end, count, points:[{date, value, unit, source_used}]}`; `read` (read-through) returns a bare array of `{date, value, unit, source_used, from_cache}`. `data_stats({concept_id})` returns per-concept `rows`, `latest_date`, `last_fetch` — a cheap freshness signal. `ai_search`/`list_concepts` return concept metadata including `frequency` (`monthly`/`yearly`) and `unit`.
- **Period-label defect observed**: one yearly concept (GDP nominal) returned `count:7` with both `"2023"` and `"2023-12-31"` present for the same period. Monthly concepts label period-start (`2026-08-01`), yearly label period-end (`2019-12-31`).
- **The write surface is broader than prefixes suggest**: `policy_delete`, `platform_trigger`, `auth_launch_login`, `enumerate_wbgapi_indicators`, `fetch` (force, writes their cache) all mutate state and none matches a create/update/add prefix. An allowlist is therefore data, not code.
- **`fd-daas-mcp`** (161 tools) has alert/cron/dashboard/research groups — all returning empty collections on the current deployment. No signal to subscribe to today.
- **`fd-cn-report`** is excluded by decision; not probed further.
- Repo facts the design leans on: `registry-credentials.liveToken(owner)` is the same per-user token the dsh child's MCP entries carry (`dsh-profile.js` injects `Authorization: Bearer`); `extension-store.getMcpServer(name).config` holds the endpoint URL; `server/dsh-events.js` already accumulates per-turn tool calls with parsed args and results into `chat_messages.blocks`; `resources.js#captureFromMessage` runs at the `recordMessage` funnel with the message text; the tool-search bridge (`dsh-profile-template/platform-tool-search-bridge.js` + `writeToolSearchPatch`) is the template for a roster-visible plugin tool; `cron.js` proves node-schedule honors `{rule, tz}`; `services/ops-console/index.js` is the poll-snapshot-retention precedent; `db.js` numbered migrations are at version 16.

## Goals / Non-Goals

**Goals:**

- Bound charts refresh without a model turn; the data path is deterministic (tool call → mapping → points), never an LLM.
- Observation history is structural (points with two time axes), so as-of views, revision tracking, and a future analytical read tool are queries.
- The replay gate is enforceable and boring: per-tool allowlist, default deny, the user's own credential.
- Zero renderer changes; zero image-persona changes (the declared channel rides a tool description like `tool_search`).
- Failure never destroys user data: stale + reason + backoff, old payload intact.

**Non-Goals** (beyond the proposal's):

- No stored per-refresh option objects — as-of views are reconstructed (the point log + frozen option template suffice).
- No inference from tool *names* or descriptions; inference uses only response-vs-option shape matching against same-turn calls.
- No UI for authoring maps — candidates carry maps proposed by declaration or inference; the user confirms a candidate, not a path expression.
- No upstream cache invalidation or read-through on refresh — bound tools are cache-reads only.

## Decisions

### D1. Binding rows + point log, not resource payload history

Schema (migrations 17–18, additive):

```
chart_bindings(
  id TEXT PK, lineage_key TEXT UNIQUE,     -- sha256(server|tool|canonical(args)|map)
  server TEXT, tool TEXT, args TEXT,       -- canonical JSON (sorted keys)
  map TEXT,                                -- see D2
  concept TEXT, frequency TEXT, unit TEXT, -- snapshot at binding time
  refresh_rule TEXT,                       -- JSON: {ttlSec?, cron?, tz?} or null
  origin TEXT, stale INTEGER, stale_reason TEXT, stale_since TEXT,
  last_ok_at TEXT, consecutive_failures INTEGER,
  created_at TEXT, updated_at TEXT
)
chart_point_revisions(                     -- append-only truth
  binding_id TEXT, series TEXT, period TEXT, value REAL, source TEXT,
  observed_at TEXT,                        -- record time
  PRIMARY KEY (binding_id, series, period, observed_at)
)
chart_series_points(                       -- materialized latest view
  binding_id TEXT, series TEXT, period TEXT, value REAL, source TEXT,
  first_seen_at TEXT, revision_count INTEGER,
  PRIMARY KEY (binding_id, series, period)
)
chart_refreshes(                           -- what we did (log, not data)
  id TEXT PK, binding_id TEXT, fetched_at TEXT, trigger TEXT,
  outcome TEXT,                            -- ok|unchanged|skipped_fresh|error
  added INT, revised INT, resourced INT, unchanged INT, missing INT,
  anomalies INT, error TEXT, duration_ms INT
)
```

Why points over snapshots: revision counts become row counts, as-of becomes a per-(series,period) latest-at-or-before query, and the rolling-window accumulation ("the chart outlives any single fetch window") falls out of the latest view. Alternatives — per-refresh option blobs (diff-on-read, no structure) or an event-sourced JSON log (same, worse query) — were rejected in explore. `chart_series_points` exists because every render wants the latest view and the render path should not aggregate the log each time; it is maintained in the same transaction as the point writes.

The chart resource's payload stays the rendered option. On a successful refresh the series arrays in the option are regenerated from the latest view through the frozen option template (title/legend/colors kept from the captured option; only the data arrays move). Resources reference bindings (`resources.binding_refs` JSON: `[{seriesIndex, bindingId}]`); a resource with bindings renders from the stored series; without, it renders its static payload — one rendering path, two data sources. This keeps the renderer contract untouched.

### D2. Mapping contract, default per probed shapes

`map` is declarative, five fields, no expressions:

```
{ rows: "points[]", period: "date", value: "value",
  source: "source_used", series: null | "<field>" }
```

`rows` is a path into the tool result: `"points[]"` (read_series object) or `"@root"` (read's bare array). One map covers one series; a multi-series chart holds one binding per series (v1: multi-series charts bind the series that have candidates; the rest stay static). Default map when a candidate is a `read_series`/`read` call: the fields above; no model input needed. A declared map overrides the default and is validated: every named field must resolve in the response, `period` values must parse under the frequency, `value` must be numeric.

Period normalization is frequency-aware and runs before dedupe: monthly → `YYYY-MM` from the period-start date; yearly → `YYYY` from either a bare year or a year-end date. Same normalized key in one response: equal values collapse; different values are an anomaly — neither written, both recorded (the probed `"2023"`/`"2023-12-31"` case). Frequency comes from concept metadata at binding time; if it is absent the binding is refused (cannot normalize safely).

### D3. Binding sources — declared > confirmed > inferred

- **Declared**: a new dsh-plugin tool `chart_bind`, patterned exactly on the tool-search bridge (`platform-chart-bind-bridge.js` copied into the profile dir by a `writeChartBindPatch()`; registers via `ctx.tools.register(defineTool(...))`; roster-visible for every preset/persona — no image or persona change, same as `tool_search`). Arguments: `{tool, args, map?, note?}`. The bridge posts to a loopback REST route on the platform server (the `cron-mcp.js` bridge pattern, loopback-exempt auth) that records the declaration against the turn's in-flight chart. Validation: tool must be `mcp__<allowlisted server>__<allowlisted read tool>` and present in the calling agent's projected roster (the bridge checks `ctx.tools.schemas(exec.agent)` locally — the same source `tool_search` uses; it cannot see unmounted entries). The tool is read-only: it registers intent, never executes the data call.
- **Confirmed**: the resources API lists same-turn candidates (name, args, proposed map); the user picks. Candidates come from the turn's `blocks` (see D4).
- **Inferred**: at capture time, run the candidate list through the evaluator — a candidate wins only if applying its map to its recorded result yields period/value arrays that uniquely match one series of the recorded option (same normalized period set; values equal within tolerance). Zero or multiple matches ⇒ no inference. Inference never overrides an existing declared/confirmed binding.

Priority is enforced on write: origin rank `declared=3 > confirmed=2 > inferred=1`; a lower-ranked source cannot replace a higher-ranked binding; a higher-ranked one can.

### D4. Candidate retention — the capture funnel already has the evidence

`server/dsh-events.js` accumulates `ctx.dshTurnBlocks` (tool name, parsed args, result text) and `chat-history.recordMessage` persists them as `chat_messages.blocks`. Today `captureFromMessage` receives only text. Change: pass the turn's blocks through to the capture (a parameter addition at the four recordMessage call sites is NOT needed — blocks already flow into `recordMessage` as the 4th parameter for assistant turns from the ws/dsh path; the cron path mirrors the same shape). The capture stores, per chart resource, the same-turn `mcp__` blocks' `{name, args, result}` as candidates (result capped, e.g. 200KB, to bound row size). Candidates are retained as long as the resource exists; they are the only source the confirmation UI offers.

### D5. Replay gate and fetcher

- **Allowlist** (`chart-replay-allowlist.json` beside the app or an env-overridable path, loaded like `registry-groups.json`): `{"servers": {"fd-open-data-mcp": ["read_series", "read"]}}`. Default deny; exact names only. The allowlist also bounds v1 scope — a server not listed has no bindable tools at all.
- **Fetcher** (`chart-source.js`): streamable-http JSON-RPC over `fetch` — `initialize` (new session per refresh; no persistent connection to manage), `notifications/initialized`, `tools/call`. Endpoint from `extension-store.getMcpServer(server).config.url`; auth header from `registry-credentials.liveToken(cellOwner)`; a null token fails the refresh with the credential reason (the same stale-401 marking the dsh path already applies). SSE responses are parsed for the last `data:` line. Timeout ~30s, one retry on transport error.
- **Refresh execution**: gate call `data_stats({concept_id})` first for scheduled/on-open ticks — if `last_fetch` and `latest_date` equal the last recorded gate values, record `skipped_fresh` and stop; manual refresh always reads. The bound call is executed with the recorded args (window args are stable; the stored series grows by our accumulation, not by widening the upstream window).

### D6. Refresh scheduling — own module, not cron jobs

`chart-refresh.js` runs its own node-schedule timers per binding with a `refresh_rule` (`{cron, tz}` or `{ttlSec}` checked on open). It does NOT create cron-module jobs: cron jobs are prompt-bound to (preset, session) and burn model turns; refresh is a data-path loop the user never sees in their task list. Missed ticks while down are skipped (no catch-up storms), mirroring cron's missed-run rule. Failure backoff: `min(2^n × 15min, 24h)` on consecutive failures, manual refresh exempt. All refresh outcomes write a `chart_refreshes` row.

### D7. Stale + payload immutability on failure

A failed refresh writes only the stale fields on the binding and the error row in `chart_refreshes`. The resource payload, the point log, and the latest view are untouched. Stale clears on the next `ok`. The UI reads `stale_reason` codes (`credential`, `unreachable`, `tool_error`, `unit_mismatch`, `map_violation`) and maps them to localized strings (server text is not localizable — the resources error-code precedent).

### D8. Timeline and as-of view (web only)

`GET /api/resources/:id/observations` returns the refresh log (paged, time-filterable server-side). `GET /api/resources/:id/as-of?at=<iso>` returns the reconstructed series: for each (series, period), the latest point revision at or before `at`, rendered through the option template into a full option — the same shape `chartOption()` already parses, so the client renders an as-of view with the existing `EChart` and no new renderer path.

### D9. Retention and growth caps

Retention sweeper (boot + daily, the ops-console pattern): prune `chart_refreshes` rows older than 30 days and superseded `unchanged` point rows (keep the first and latest observation per point; revisions are permanent). Point-revision rows for periods whose values changed are never pruned. A per-binding period cap (default 600) drops oldest periods from the latest view only — the log keeps them, as-of keeps working.

### D10. Client surfaces

Web: the chart card gains the source line, refresh, stale badge, unbind, data-period filter; the observation timeline is a card expansion (web only). MP: source line, refresh, stale badge, data-period filter; older cells answer the new routes 404 and the affordances hide (the library's established version-skew rule). Both use `packages/core` API additions; five-locale keys with the existing parity check.

## Risks / Trade-offs

- [Upstream changes shape (fields renamed, wrapper added)] → the map evaluator validates every field on every refresh; a violation is `map_violation`, stale, old data intact. A shape change costs a map update, not a data loss.
- [The period-label defect grows (more variants than bare-year/year-end)] → normalization handles the two observed forms; anything else fails safe as an anomaly, and anomalies are surfaced in the timeline rather than absorbed.
- [A binding's args pin a stale concept id after upstream re-keying] → refresh returns empty/different concept data; the unit/mapping checks and the freshness gate catch most cases; residual risk accepted (the user unbinds; the chart's static payload survives).
- [Point-log growth on many bindings × tight cron rules] → the retention sweeper + period cap bound steady-state size; the cap default (600) is configurable per deployment.
- [Declared bindings from a weak model (wrong tool or args)] → declaration validates against the roster and the allowlist, and the first refresh's mapping validation is the backstop; a bad declared binding surfaces as stale with a reason the user can read and unbind.
- [Multi-series charts partially bound] → v1 renders bound series from the store and static series from the payload; the card labels per-series binding state so a half-bound chart is honest about it.
- [Same-turn candidate results bloat the resources row] → candidate results are capped at capture; older candidates can be pruned by the same retention sweeper (bindings, once attached, no longer need the candidate).

## Migration Plan

1. Ship the cell: migrations 17–18 additive; allowlist file defaults to fd-open-data-mcp read tools; the chart-bind bridge patch is written on profile regeneration (next child restart) — an old child simply lacks the declared channel; candidates still flow from blocks (data already in `chat_messages.blocks` for new turns). No backfill: existing charts are unbound until their users bind them (seeding bindings retroactively from stale turn data was considered and rejected — result evidence older than the current fetch window cannot validate).
2. Web build in the same pipeline: affordances light up on the new cell, hide gracefully on old ones.
3. Mini program last: version bump + devtools walkthrough + upload/审桁 handoff, per the library's clock.
4. Rollback: tables and routes are additive; an old build ignores them. The allowlist file and the sweeper are no-ops without bindings. Removing the capability drops the bindings and their history deliberately (the charts themselves keep their static payloads).

## Open Questions

- The 200KB candidate cap and the 600-period cap values — tunable at implementation; env-overridable constants, no spec impact.
- Whether `read`'s read-through behavior (it fetches upstream on cache miss) violates the "no upstream fetch on refresh" rule in spirit — v1 binds `read_series` by default and `read` only via explicit declaration; if first live probing shows `read` fetching on every call, it leaves the default allowlist.
- The exact minimal JSON-RPC client surface (one initialize per refresh vs a pooled session per binding) — implementation detail; the probe will pick the simpler one that survives retry semantics.
