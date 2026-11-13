## ADDED Requirements

### Requirement: Catch-up window misses are alerted, not only recorded

The cron runner SHALL complement the existing tolerance-window catch-up (2× period, 6h floor, `PLATFORM_CRON_CATCHUP` kill switch) with an explicit alert when beats fall outside the window and are skipped. The alert SHALL name the job and the missed-beat count and ride the same alerting channel used by other platform components (metering explicit-alerting precedent). The existing record-only behavior for in-window catch-up is unchanged.

#### Scenario: Beats outside tolerance window surface as alerts

- **WHEN** a job's beats are skipped because the downtime exceeds the tolerance window
- **THEN** an alert event naming the job and missed count is emitted in addition to the per-task miss record

### Requirement: Fleet rounds skipped for missing registry listing are visible

When the fleet scheduler skips a pass because the registry listing fails, the skip SHALL be recorded with its reason on the run ledger (not only the log line), so skipped passes are countable and queryable like missed cron beats.

#### Scenario: Skipped fleet pass is countable

- **WHEN** a scheduled fleet pass is skipped due to a registry listing failure
- **THEN** the skip is recorded with the reason on the fleet run ledger and appears in the same query surface as executed rounds
