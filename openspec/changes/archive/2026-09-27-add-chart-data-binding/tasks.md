# add-chart-data-binding — tasks

Phase 1 is the server-side data path, runnable and testable with zero model involvement. Phases are ordered so each lands verifiable on its own.

## 1. Point store, fetcher, and refresh loop (server closed loop)

- [x] 1.1 `db.js` migrations 17–18: `chart_bindings` (with `lineage_key UNIQUE`, origin/stale/backoff columns), `resources.binding_refs`, `chart_point_revisions`, `chart_series_points`, `chart_refreshes` + indexes; verify a fresh cell migrates and a rollback-graded old build ignores the tables.
- [x] 1.2 `chart-source.js`: streamable-http JSON-RPC client (initialize → notifications/initialized → tools/call; SSE `data:` parsing; 30s timeout + one transport retry), endpoint from `extension-store`, bearer from `registry-credentials.liveToken`; verify against an in-process fake MCP (plain Node http server) that mirrors the probed response shapes (`read_series` object + `points[]`, `read` bare array).
- [x] 1.3 Map evaluator + frequency-aware normalization: five-field declarative map (`rows`/`period`/`value`/`source`/`series`), `@root` and `points[]` row paths, monthly → `YYYY-MM` / yearly → `YYYY`, same-response duplicate collapse, same-period-different-value anomaly (neither written, both recorded); verify unit tests cover every probed defect case including the `"2023"`/`"2023-12-31"` pair.
- [x] 1.4 Point diff + transactional writes: classify appended/revised/resourced/unchanged/missing, maintain `chart_series_points` and append `chart_point_revisions` in one transaction, write the `chart_refreshes` row, regenerate the resource payload's series arrays through the frozen option template; verify a simulated append+revise+resourced refresh produces the right rows, counts, and a payload whose non-data fields are untouched.
- [x] 1.5 Replay allowlist: `chart-replay-allowlist.json` (default `fd-open-data-mcp: [read_series]`, `read` off pending the open question), default-deny, exact names; verify a binding naming `policy_delete` or `fetch` is refused refresh with the allowlist reason.
- [x] 1.6 `chart-refresh.js`: per-binding node-schedule timers from `refresh_rule` (`{cron, tz}` / `{ttlSec}`), the `data_stats` freshness gate for scheduled/on-open ticks (manual bypasses), failure backoff `min(2^n × 15min, 24h)`, missed-ticks-skipped, sweeper (30-day refresh-log/unchanged-point pruning, unreferenced-binding cleanup, period cap on the latest view); verify the closed loop against the fake MCP: tick → gate → read → diff → broadcast.

## 2. Binding identity and capture candidates (no model involvement)

- [x] 2.1 Binding lifecycle in `chart-bindings.js`: lineage key `sha256(server|tool|canonical(args)|map)`, origin ranking declared > confirmed > inferred with the no-downgrade rule, concept/frequency/unit snapshot at attach; verify same-identity attach reuses one row across charts and a lower origin cannot replace a higher one.
- [x] 2.2 Candidate retention at the capture funnel: pass the turn's blocks into `resources.captureFromMessage`, store same-turn `mcp__` blocks (name, args, result capped 200KB) as candidates on the chart resource; verify a chart from a turn with MCP calls carries candidates and the existing no-candidate paths (web search, RAG, no tools) capture unchanged.
- [x] 2.3 Witness-based inference: apply each candidate's default map to its recorded result, match normalized period sets and values (tolerance) against the recorded option's series; only a unique match binds with origin `inferred`; verify zero-match, multi-match, and unique-match cases, and that inference never overrides declared/confirmed.
- [x] 2.4 Unit contract: binding records the unit at attach; a refresh response whose unit differs is refused whole with `unit_mismatch`; verify a `%` → `亿元` switch writes nothing and marks stale.
- [x] 2.5 REST mutations in `server/routes/resources.js` + `packages/core` API: attach-from-candidate, detach, set refresh rule, trigger refresh, list observations, as-of query; every mutation broadcasts the existing `resources_changed` event; verify HTTP round-trips behind the cell auth gate and the loopback exemption the declared channel needs.

## 3. Declared channel (dsh plugin)

- [x] 3.1 `dsh-profile-template/platform-chart-bind-bridge.js`: `ctx.tools.register(defineTool(...))` for `chart_bind({tool, args, map?, note?})`, roster validation via `ctx.tools.schemas(exec.agent)`, allowlist check, loopback POST to the platform's binding route (cron-mcp bridge pattern); verify the plugin never executes the data call and a rejected declaration returns a reason the model can relay.
- [x] 3.2 `dsh-profile.js#writeChartBindPatch()` alongside the tool-search patch writer; verify the patch lands on profile regeneration and a profile without it boots and chats unchanged.
- [x] 3.3 Loopback binding route: records the declaration against the in-flight turn's chart (origin `declared`), validates map shape; verify end-to-end against a real dsh child: turn → `read_series` call → chart fence → `chart_bind` → binding attached.

## 4. Web surfaces

- [x] 4.1 `packages/core`: resource types gain binding refs, stale state, source-line fields; API client for the new routes; verify type-level round-trip against a local cell.
- [x] 4.2 Chart card: source line (server · tool · as-of age), refresh action, stale badge with localized reason codes, unbind (confirm), per-series binding state on multi-series charts; verify an unbound chart shows none of it and an older-cell 404 hides the affordances.
- [x] 4.3 Data-period filter (近 6 月 / 近 1 年 / 全部) over the stored series, defaulting to the recent window; verify a 30-month stored series slices correctly and `全部` renders every stored period.
- [x] 4.4 Observation timeline: refresh list (moment, trigger, outcome, counts, anomalies) with observation-time filter, as-of view through the existing renderer with a clear current/as-of distinction and one-action return; verify against a scripted sequence of refreshes (append/revise/fail).
- [x] 4.5 i18n keys in all five locales (en source of truth, parity check); verify `check:locales` passes.

## 5. Mini program alignment

- [x] 5.1 Resources page: source line, refresh action, stale badge, data-period filter; verify older-cell degradation hides all four without errors (devtools walkthrough, WXML-class assertions).
- [x] 5.2 Canvas renderer redraw on refresh broadcast; verify the live-update path (broadcast → refetch → redraw) with the devtools automation flow.

## 6. Verification inventory and live probe

- [x] 6.1 Unit suites: `scripts/test-chart-source.mjs` (fake MCP end-to-end: gate, read, map, normalize, diff, write, broadcast), map/normalization/diff/allowlist edge cases, capture-candidate retention, lineage dedupe, stale/backoff semantics, retention sweeper; run the full `npm run test:unit` and record pre-existing flakes separately.
- [x] 6.2 E2E (fast project): bind-from-candidate → manual refresh → chart redraw (canvas assertion); scheduled refresh with the fake MCP as the configured server; stale path (fake MCP returning 500) keeps the old render.
- [x] 6.3 Live probe `scripts/probe-chart-bind-live.mjs`: against fd-prod (or the tailnet NodePort), mint the owner credential, bind a real monthly concept (e.g. M0_YOY country CN), one manual refresh, assert the point rows + payload update + timeline entry; record the probe transcript in the change notes.
- [x] 6.4 Deploy through the standard pipeline (Jenkins `platform` → GitOps tag → ArgoCD), pod smoke (0 restarts), ops-console board agreement, and the MP upload/提审 handoff on the client clock.
