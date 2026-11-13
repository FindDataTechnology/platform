## ADDED Requirements

### Requirement: Idle liveness follows the user's connection, not just HTTP traffic

The gateway SHALL treat a cell as live while the user holds an attached proxied WebSocket, and
SHALL start a cell's idle clock when the cell begins serving rather than when its process was
forged: a cold boot takes seconds, and counting that boot as idle let the reaper stop a cell
before it could serve the request that spawned it. Requests that queue behind an in-flight
spawn SHALL also count as traffic once that spawn materializes, because they are the demand the
cell is being started for.

A cell reaped for quiet SHALL NOT lose the user's work: scheduled jobs live in the cell's store
and are restored when the cell cold-starts or is woken by the duty ring.

#### Scenario: an attached WebSocket keeps the cell from being reaped

- **WHEN** a user's chat sits on its proxied WebSocket for longer than the idle window without issuing any HTTP request
- **THEN** the gateway does not reap that user's cell while the socket is attached
- **AND** the cell is eligible for reaping again only after the socket closes and the window elapses

#### Scenario: a cold boot is not counted as idle time

- **WHEN** a first request has to spawn a cell and the boot takes longer than the idle window
- **THEN** the cell is not reaped before it begins serving, and the request is answered by the cell that was started for it
- **AND** further requests arriving while that spawn is in flight keep it alive instead of being aged out and retried into a new spawn

#### Scenario: parking a cell preserves its scheduled work

- **WHEN** a cell holding an enabled cron job is reaped for quiet under its residency policy
- **THEN** the job is still present after the cell cold-starts on the user's next request
