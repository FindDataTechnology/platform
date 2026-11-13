## ADDED Requirements

### Requirement: Demo cells run under a bounded lifecycle distinct from account cells

Cells started for demo identities (see the `mp-demo-mode` capability) SHALL be
managed separately from account cells: the gateway SHALL cap how many demo
cells run concurrently, SHALL stop a demo cell after a short configurable idle
window even when general idle reaping is disabled, and SHALL delete a demo
cell's data directory when the cell is stopped. Account cells SHALL keep the
existing resident, persistent contract regardless of demo-cell activity.

#### Scenario: demo reaping is independent of the deployment-wide setting

- **WHEN** idle reaping is disabled for account cells and a demo cell exceeds the demo idle window
- **THEN** the demo cell is stopped and its data directory is deleted, while account cells remain running

#### Scenario: account cells are unaffected by demo cleanup

- **WHEN** a demo cell is reaped and deleted
- **THEN** every account cell keeps running with its data directory intact
