## ADDED Requirements

### Requirement: LiteLLM is configured with a Postgres database for the admin UI
When bundled LiteLLM runs with the bundled Postgres, the supervisor SHALL inject into the LiteLLM child environment: `DATABASE_URL=postgresql://postgres@localhost:<pgPort>/litellm`, `LITELLM_MASTER_KEY` (the master key the admin UI checks), `LITELLM_SALT_KEY` (generated once on first run, persisted, never regenerated), and `STORE_MODEL_IN_DB=True`. The supervisor SHALL prepend the LiteLLM venv `bin` and the bundled Node `bin` to `PATH` and SHALL set `PRISMA_QUERY_ENGINE_BINARY` to the bundled query-engine path, so litellm's Prisma subprocess finds `prisma` and `node`. The bundled venv SHALL include the generated Prisma client (`site-packages/prisma/`) and the query engine. The admin UI SHALL initialize against the DB (no "Missing Environment Variables" screen).

#### Scenario: LiteLLM starts with a DB
- **WHEN** bundled LiteLLM starts after Postgres is healthy
- **THEN** the LiteLLM child env SHALL include `DATABASE_URL`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, `STORE_MODEL_IN_DB=True`, `PRISMA_QUERY_ENGINE_BINARY`, and a `PATH` containing the venv bin + bundled node bin
- **AND** the admin UI SHALL initialize (no missing-env screen)

#### Scenario: salt key is generated once and never regenerated
- **WHEN** the app first runs
- **THEN** bootstrap SHALL generate `LITELLM_SALT_KEY` and persist it to settings
- **AND** SHALL NOT overwrite it on subsequent runs (changing it would orphan encrypted DB values)

#### Scenario: Prisma client and engine are bundled in the venv
- **WHEN** `npm run predist` builds the LiteLLM venv
- **THEN** the venv SHALL include the generated Prisma client in `site-packages/prisma/`
- **AND** the platform-correct query engine at a stable path under the venv

#### Scenario: external DATABASE_URL uses an external DB
- **WHEN** the user sets `DATABASE_URL` to an external Postgres
- **THEN** LiteLLM SHALL use that DB
- **AND** bundled Postgres is not spawned
