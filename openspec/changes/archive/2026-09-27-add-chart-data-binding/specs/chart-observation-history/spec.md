# chart-observation-history Specification (delta)

## Purpose

Stores the history of a bound chart's data as append-only, point-level observations with two time axes — the period the data is about (valid time) and the moment it was observed (record time) — so revision tracking, as-of reconstruction, and future analytical reads are queries over structured rows rather than diffs of stored snapshots.

## ADDED Requirements

### Requirement: Observations are point-level and append-only

The system SHALL store observed data as points keyed by (binding, series, period) with the value, the source that produced it, and the observation moment; the point log SHALL be append-only — a point once observed SHALL never be rewritten or deleted except by the retention path. Each completed refresh SHALL classify every point in the response against the previously observed state as exactly one of: **appended** (period not previously observed), **revised** (same source, different value), **resourced** (different source, different value), **unchanged** (same value), or **missing** (a period that the frequency calendar says should exist within the observed range but has no value in the response). The refresh SHALL be logged with per-classification counts, the trigger, the outcome, and the duration. A response whose unit differs from the binding's recorded unit SHALL be refused in full (the binding capability's rule) — it SHALL NOT be partially classified.

#### Scenario: a refresh that appends and revises

- **WHEN** a refresh returns one period not seen before and one previously observed period with a new value from the same source
- **THEN** the new period is recorded as appended and the changed one as revised
- **AND** the refresh log row reports one append and one revision
- **AND** the previous value of the revised period remains in the point log

#### Scenario: a source switch is not reported as a data revision

- **WHEN** a previously observed period returns a different value and the response's source field differs from the previously recorded source
- **THEN** the point is classified as resourced, not revised

#### Scenario: a period absent from the response is not deleted

- **WHEN** a refresh response omits a period that was previously observed and that period lies within the response's own reported range
- **THEN** the previously observed value is retained unchanged
- **AND** the period is classified as missing in that refresh's log

### Requirement: Periods normalize by the series frequency

The system SHALL normalize each response period to a canonical key according to the concept's frequency (monthly → `YYYY-MM`, yearly → `YYYY`) before any comparison or storage. The normalization SHALL be applied before deduplication: a response containing multiple representations of the same period (for example a bare year and a year-end date) SHALL be stored once. When two representations of the same normalized period carry different values in one response, the conflict SHALL be recorded as an anomaly with both values, the response's points for that period SHALL be refused (neither value written), and the refresh SHALL report the anomaly — the system SHALL NOT silently pick one value. The period label shown to users in lists and timelines SHALL be the normalized key.

#### Scenario: duplicate period representations collapse

- **WHEN** a response contains both `2023` and `2023-12-31` for a yearly series with the same value
- **THEN** one point is stored under the normalized key `2023`

#### Scenario: same-period different-value is an anomaly, not a choice

- **WHEN** a response contains two representations of the same normalized period with different values
- **THEN** no point is written for that period from that response
- **AND** the conflict with both values is recorded as an anomaly
- **AND** the refresh outcome reports it

### Requirement: Any past view is reconstructable as-of a moment

The system SHALL be able to reconstruct the state of a bound series as of any past observation moment: for every (series, period), the value in force at that moment — the latest observation at or before it — SHALL be queryable. The chart shown for a past observation SHALL be this reconstruction, not a stored snapshot; the system SHALL NOT need to have stored per-refresh option objects to render a past view. This reconstruction contract SHALL be exposed as a query surface (REST in v1) that returns, for a binding and a moment, the periods, values, and sources in force — the same contract a future analytical tool reads.

#### Scenario: a period revised between two refreshes

- **WHEN** period `2026-03` was observed as `15.3` at 09:00 and as `15.1` at the next day's 09:00, and the user views the chart as of the first day 12:00
- **THEN** the reconstruction returns `15.3` for `2026-03`

#### Scenario: a period not yet observed at a moment

- **WHEN** the user views the chart as of a moment before a period's first observation
- **THEN** that period is absent from the reconstruction

### Requirement: The observation timeline is visible and filterable

Each bound chart SHALL expose its refresh history as a timeline: one entry per refresh with its moment, trigger, outcome, and per-classification counts (appended / revised / resourced / unchanged / missing, plus anomalies); each entry with changes SHALL offer a view of the chart as of that refresh. The timeline SHALL be filterable by observation time (a range or a recent-window preset). The chart view SHALL additionally offer a data-period filter (recent windows such as last 6 months / last year / all) that selects which periods of the stored series are rendered; because a bound series accumulates beyond any single fetch window, this filter SHALL operate over the stored observations, and its default SHALL show the most recent periods.

#### Scenario: the timeline shows what each refresh did

- **WHEN** the user opens a bound chart's timeline after a refresh that appended one period and revised two
- **THEN** that refresh's entry reports 1 append and 2 revisions
- **AND** opening its as-of view reconstructs the chart at that refresh

#### Scenario: the data-period filter slices the stored series

- **WHEN** a bound chart holds 30 months of stored observations and the user selects last 6 months
- **THEN** only the most recent 6 monthly periods are rendered
- **AND** selecting all renders every stored period

### Requirement: A chart's rendered data is the latest observation

For normal (non-historical) viewing, a bound chart's rendered series SHALL be the latest observed value for each period. A successful refresh that changes any point SHALL update the chart's stored option payload accordingly and SHALL notify connected clients through the existing library-change event, so an open chart redraws without a reload. A refresh that changes nothing SHALL leave the payload byte-identical.

#### Scenario: an open chart redraws after a refresh

- **WHEN** a scheduled refresh revises a period while the user has the chart open
- **THEN** the chart redraws with the new value without a manual reload

#### Scenario: an unchanged refresh does not churn the payload

- **WHEN** a refresh returns values identical to the latest observations
- **THEN** the chart's payload is not rewritten
- **AND** the refresh is logged as unchanged

### Requirement: Retention preserves changes and prunes the rest

The system SHALL retain point revisions (rows that changed the value in force for their period) indefinitely while their binding is referenced. Unchanged observations and failed-refresh log rows SHALL be pruned after a configurable retention window (default 30 days); pruning SHALL NOT remove any point revision row. A binding no resource references SHALL be removed together with its point log and refresh log by the cleanup path, and SHALL NOT be resurrected by a later capture of an identical lineage — a fresh capture creates a fresh binding with fresh history.

#### Scenario: unchanged observations age out, revisions stay

- **WHEN** the retention window passes over a period whose value never changed
- **THEN** its unchanged observation rows are pruned
- **AND** any revision rows for any period remain queryable

#### Scenario: an unreferenced binding is cleaned up

- **WHEN** the last resource referencing a binding is deleted
- **THEN** the binding and its observation history are removed
- **AND** a later chart bound to the same data call starts with a fresh history

### Requirement: Bound-series growth is bounded per binding

A single binding SHALL cap the number of stored periods (a configurable per-binding maximum). When a refresh would push the stored series beyond the cap, the OLDEST periods SHALL be dropped from the materialized latest view first — but the point log within the retention rules above is unaffected, and the as-of reconstruction contract is unaffected for periods still logged. The cap SHALL default to a value that comfortably exceeds the upstream window (so growth beyond a single fetch window remains possible) while bounding row growth.

#### Scenario: growth beyond the cap drops oldest first

- **WHEN** a stored series reaches the period cap and a refresh appends a new period
- **THEN** the oldest period leaves the rendered series
- **AND** the point log for that period is unaffected by the cap
