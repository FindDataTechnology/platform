# cell-gateway Specification Delta

## MODIFIED Requirements

### Requirement: Cells start on demand and are always-on by default

The gateway SHALL start a user's cell on that user's first authenticated traffic, using that user's dedicated data directory and agent home. By default a started cell SHALL remain running. When idle reaping is enabled, the gateway MAY stop a cell after a configurable idle period, EXCEPT a cell with enabled cron jobs or enabled bots SHALL NOT be reaped. The deployment SHALL document the offline contract: a reaped (stopped) user cell means that user's chat is briefly unavailable on next visit (cold start) and that user's scheduled jobs do not fire while stopped.

The gateway SHALL maintain at most one cell process per user at any time: concurrent first requests for the same user SHALL collapse onto a single spawn (the in-flight spawn is registered before the spawn begins, not after it returns), and a cell record SHALL never be replaced while its process is still alive — a replacement SHALL first terminate the recorded process. A cell process whose record was replaced SHALL NOT be left running unreachable.

#### Scenario: first visit cold-starts the user's cell
- **WHEN** an authenticated user with no running cell makes a request
- **THEN** the gateway starts their cell and serves the request once the cell is ready

#### Scenario: scheduled jobs block reaping
- **WHEN** idle reaping is enabled and a cell has at least one enabled cron job or bot
- **THEN** the gateway leaves that cell running despite idleness

#### Scenario: concurrent first requests spawn one cell
- **WHEN** two requests for the same user arrive while that user's cell is still starting
- **THEN** exactly one cell process is spawned and both requests are served by it

#### Scenario: replacing a record terminates the old process
- **WHEN** a cell is spawned for a user whose previous record still holds a live process
- **THEN** the previous process is terminated before or during the replacement, leaving at most one live process for that user

#### Scenario: no orphan process survives record removal
- **WHEN** a cell record is dropped or replaced (share-respawn path, idle stop, crash recovery)
- **THEN** no live process for that user remains without a record, and a subsequent ensure starts exactly one fresh cell
