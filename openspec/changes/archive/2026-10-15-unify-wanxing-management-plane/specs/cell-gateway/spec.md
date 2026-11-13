## ADDED Requirements

### Requirement: Cell task telemetry reaches the fleet plane read-only

The gateway MAY be configured (fleet ingest URL + credential + sample interval) to sample the
task stats endpoint of every live cell it owns and report one `cell_stats` event per cell per
tick to the fleet ingest channel — the same observation plane runner heartbeats use. Unconfigured
SHALL mean the reporter does not run (zero behavior change). Reporting SHALL be best-effort and
log-only: a failed sample or ingest NEVER affects cell traffic, and SHALL NOT block request
handling. The channel is one-directional telemetry — no control action SHALL be introduced that
reaches into a cell through it.

#### Scenario: Unconfigured default changes nothing

- **WHEN** the gateway runs without the fleet ingest configuration
- **THEN** no sampler runs, no outbound fleet traffic occurs, and cell routing behaves identically

#### Scenario: Live cells are sampled and reported per tick

- **WHEN** the reporter is configured and two cells are live
- **THEN** each tick posts a `cell_stats` event per live cell carrying that cell's stats snapshot,
  addressed by a stable per-cell identity

#### Scenario: A dead or erroring cell degrades to absence

- **WHEN** a cell's stats sample fails or the cell has exited
- **THEN** that cell contributes no event that tick (stale rows age out of the board window on
  their own) and the remaining cells are still reported
