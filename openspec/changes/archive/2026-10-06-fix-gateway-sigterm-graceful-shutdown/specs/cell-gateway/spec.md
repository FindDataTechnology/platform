## ADDED Requirements

### Requirement: The gateway shuts down gracefully on termination signals

On SIGTERM or SIGINT, the gateway SHALL stop its cells through the cell registry (the "no cell outlives the gateway" invariant), close its auxiliary registries (share-token store, and the pack registry when running in pack mode), and exit with code 0 — in that order of precedence, with cell shutdown never skipped. A failure in any auxiliary close SHALL be isolated (logged, non-fatal) rather than aborting the shutdown chain. The shutdown path SHALL be mode-safe: the pack registry's close SHALL be reached identically in pack mode and facet-proxy mode (a no-op or guarded call in the latter), and neither mode SHALL reference an undefined binding.

#### Scenario: Pack-mode gateway exits cleanly on SIGTERM

- **WHEN** a gateway running in pack-registry mode (no FACET_BASE_URL) receives SIGTERM with cells resident
- **THEN** it SHALL log the cell stop, stop its cells via the registry, close the share and pack registries, and exit 0 — with no unhandled rejection or ReferenceError

#### Scenario: A failing auxiliary close does not skip cell shutdown

- **WHEN** the share-registry or pack-registry close throws during shutdown
- **THEN** the error SHALL be logged and swallowed, and the cell registry shutdown SHALL still run to completion before exit
