## ADDED Requirements

### Requirement: Postgres is a supervisor-managed bundled service
The supervisor SHALL manage a `postgres` descriptor (`kind: "postgres"`) that, when bundled Postgres resources are present (`resources/postgres/bin/postgres`) AND the user has not set an external `DATABASE_URL`, resolves to its bundled form: run `initdb` on first start into `PLATFORM_DATA_DIR/postgres-data`, start Postgres on a free localhost port, health-check it (TCP-poll the port), and stop it via `pg_ctl`. When the user sets an external `DATABASE_URL`, the bundled Postgres SHALL be skipped (external-override, mirroring the LiteLLM/OpenConnector pattern). The LiteLLM descriptor SHALL declare `dependsOn: ["postgres"]` so LiteLLM starts only after Postgres is healthy.

#### Scenario: bundled Postgres starts before LiteLLM
- **WHEN** the app starts with bundled Postgres and bundled LiteLLM
- **THEN** the supervisor starts Postgres and waits for its TCP health check to pass
- **AND** then starts LiteLLM with `DATABASE_URL=postgresql://postgres@localhost:<pgPort>/litellm` in its environment

#### Scenario: external DATABASE_URL skips bundled Postgres
- **WHEN** the user sets `DATABASE_URL=postgresql://...` in settings
- **THEN** the supervisor SHALL NOT spawn bundled Postgres
- **AND** LiteLLM SHALL use the external `DATABASE_URL`

#### Scenario: Postgres failure does not block the app
- **WHEN** bundled Postgres fails to start
- **THEN** the supervisor marks it unhealthy
- **AND** LiteLLM starts without a DB (admin UI degrades; the proxy still serves `/v1/*` from `litellm.yaml`)

#### Scenario: Postgres is stopped on shutdown
- **WHEN** the app quits
- **THEN** the supervisor stops Postgres via `pg_ctl -D <dataDir> -m fast -w stop` in reverse dependency order (before Postgres's dependents)
