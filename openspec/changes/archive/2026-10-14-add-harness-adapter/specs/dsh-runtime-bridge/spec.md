# dsh-runtime-bridge 变更（add-harness-adapter）

## ADDED Requirements

### Requirement: The bridge's live-control surface is dsh-specific depth

The platform bridge's live-control methods (`preset/set`, `model/set`, `tools/set`,
`session/cancel`, `platform/stream` forwarding) and the pod-serving composition they enable
SHALL be understood as dsh-specific depth, not part of the harness-adapter contract
(openspec: harness-adapter). A host driving a non-dsh harness SHALL detect the surface's
absence through the adapter's capability report and degrade to that harness's native
equivalents (for ACP: model selection through `session/set_config_option`, cancellation
through `session/cancel`, streaming through the ACP wire) — never by assuming the platform
bridge exists, and never by silently skipping a control the caller requested.

#### Scenario: A control the harness lacks is reported, not assumed

- **WHEN** the host requests a live persona switch on an ACP-harness agent
- **THEN** the adapter's capability report (not the bridge) is the source of truth: the
  request fails structurally naming the unsupported capability, and no bridge method is probed

#### Scenario: The dsh path is unchanged

- **WHEN** a dsh-harness agent is served after this change
- **THEN** the bridge's method set, parking semantics, stream forwarding, and pod serving
  behave exactly as before — the interface refactor is invisible to the dsh path
