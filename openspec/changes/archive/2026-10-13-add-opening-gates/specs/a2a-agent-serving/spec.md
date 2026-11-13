# a2a-agent-serving 变更（add-opening-gates）

## ADDED Requirements

### Requirement: Deploy is capacity-gated by the fleet waterline

A deploy that brings a NEW child onto the fleet (the pack has no in-service deployment) SHALL be refused when the best available target runner's memory headroom (`budget_mb_limit − budget_mb` from the fleet board) is below the configured waterline (`FLEET_CAPACITY_WATERLINE_MB`, default 512). The refusal SHALL be a structured 503 naming the runner, its headroom, and the waterline (`FLEET_AT_CAPACITY`), so the deployer knows what to wait for. Redeploys and upgrades of an already-in-service pack SHALL skip this gate — capacity pressure must never wedge a live service's lifecycle. When the fleet holds multiple runners, targets are considered in the scheduler's placement order and the first target with headroom at or above the waterline wins; all-below-waterline refuses. When the capacity signal is unknowable (scheduler unarmed, board unreachable), the gate SHALL degrade open — an observability gap never blocks a deploy (the same discipline as the model roster gate).

#### Scenario: A new deploy is refused below the waterline

- **WHEN** a deploy would add a new child and the best target runner's headroom is below the waterline
- **THEN** the request is refused with 503 `FLEET_AT_CAPACITY` naming the runner, its headroom, and the waterline, and nothing is written to the registry

#### Scenario: An upgrade skips the gate

- **WHEN** a pack already in service is redeployed (same or new version) while the fleet is below the waterline
- **THEN** the deploy proceeds exactly as before — the gate never wedges a live service

#### Scenario: A target above the waterline admits the deploy

- **WHEN** a new deploy targets a runner whose headroom is at or above the waterline
- **THEN** the deploy proceeds; with multiple runners the first placement candidate above the waterline is chosen

#### Scenario: Unknowable capacity degrades open

- **WHEN** the scheduler is unarmed or the board is unreachable during a new deploy
- **THEN** the deploy proceeds — the gate only refuses on a positive below-waterline reading

### Requirement: The access mode governs the deploy identity gate

The deploy gate SHALL admit the pack author, users in the configured creator group, and — when `PACK_ACCESS_MODE=open` — any authenticated user. In `closed` mode (the default, including unset) refusals SHALL be byte-identical to the pre-change contract. Opening the access mode SHALL change nothing else: private-pack visibility, in-service/foreign-deploy rules, billing-key validation, and the model gates all apply unchanged. The facet surface's `whoami` SHALL carry the effective `accessMode` so the active posture is observable.

#### Scenario: Closed mode keeps the exact refusal

- **WHEN** a user who is neither the author nor in the creator group deploys in `closed` mode
- **THEN** the 403 refusal is byte-identical to the pre-change contract

#### Scenario: Open mode admits any authenticated user

- **WHEN** `PACK_ACCESS_MODE=open` and an authenticated non-creator deploys a public pack
- **THEN** the deploy proceeds under that user's identity, with every downstream gate (billing key, model whitelist/lane/roster, capacity) unchanged

#### Scenario: The effective access mode is observable

- **WHEN** the facet `whoami` route is read
- **THEN** the response carries `accessMode` reflecting the deployment's effective setting
