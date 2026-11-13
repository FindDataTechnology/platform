## ADDED Requirements

### Requirement: A deploy-time model choice must resolve on the hosting runner's roster

A deploy-time (and config-write) model choice passes TWO existing gates — the serving contract's model whitelist and the deployment key's sub2api lanes. Neither knows what the hosting runner's dsh tree can actually resolve: a lane-authorized model absent from the runner's model roster fails SILENTLY in the child (provider resolution error → empty answer → a billed turn that returned nothing). The deploy action SHALL therefore also validate each requested model choice against the roster of the runner the deploy is placed on, sourced from that runner's fleet heartbeat (the observer board's runner stats). The roster gate SHALL degrade open when the roster cannot be known — the fleet scheduler is not armed, the board is unreachable, or the placed runner's heartbeat does not yet carry a roster (older runner image) — matching the scheduler's health-blindness discipline; it SHALL never block a deploy on missing observability. A roster is only authoritative when present as a list; an empty list refuses every model choice with the roster error.

#### Scenario: A lane-authorized but roster-absent model is refused at deploy

- **WHEN** a deploy request carries a model choice that passes the whitelist and the key's lanes, but the placed runner's heartbeat reports a roster that does not include it
- **THEN** the deploy is refused with a roster error naming the model and the runner's available models, and no agent entry is registered

#### Scenario: The gate degrades open when the roster is unknowable

- **WHEN** the fleet scheduler is unarmed, the board fetch fails, or the placed runner's heartbeat carries no roster field
- **THEN** the deploy proceeds without a roster decision, exactly as before this gate existed

#### Scenario: The runner heartbeat carries the authoritative roster

- **WHEN** a runner emits its periodic runner_stats heartbeat
- **THEN** the payload carries the model id list its composed child profiles resolve (the same source the child settings.yaml is written from), and the observer board exposes it on the runner's stats row verbatim
