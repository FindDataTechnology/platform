## Why

The LiteLLM admin UI (model/key/user management) cannot run against the bundled LiteLLM proxy because the proxy is in "proxy-only" mode: it has no database, and litellm 1.53.9 requires a **Postgres** database (its Prisma schema uses the `Json` type, which Prisma's SQLite connector rejects - 35 validation errors) plus `LITELLM_MASTER_KEY`/`LITELLM_SALT_KEY` env vars. Users opening the LiteLLM view see a "Missing Environment Variables: DATABASE_URL, LITELLM_MASTER_KEY" setup screen, and the view only offers an open-in-new-tab link instead of an in-app dashboard. Bundling Postgres as a 4th supervisor-managed service (packaged into the DMG/EXE) and wiring it to LiteLLM makes the admin UI functional **and** embeddable in-page.

## What Changes

- **Bundle Postgres** as a new supervisor-managed service: portable Postgres binaries (bin/lib/share) for mac arm64, mac x64, and win x64 in `resources/postgres/`; first-run `initdb` into `PLATFORM_DATA_DIR/postgres` (persistent, update-safe - the macOS bundle is read-only); `pg_ctl start` on a free port with `pg_isready` health check and clean `pg_ctl stop`. LiteLLM gains `dependsOn: ["postgres"]`.
- **Wire Postgres to LiteLLM**: install `prisma` in the bundled venv + `prisma generate` (litellm's postgres schema, per-platform engine) in `build-python-litellm.js`; pass `DATABASE_URL`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY` (salt generated once, persisted in `dev-settings.json`) to the LiteLLM child via `descriptors.js` + `SETTING_KEYS`. The admin UI initializes against the DB.
- **Embed the LiteLLM admin UI in-page** via the `/litellm-web` proxy (same-origin iframe, proxying the dashboard's `/ui/*` SPA paths) instead of the open-in-new-tab link - now feasible because a DB makes the dashboard functional. **BREAKING** (UX): the LiteLLM nav entry no longer opens a new tab; it renders the dashboard in-app.
- Bundle size increases (~Postgres binaries per platform); first-run adds an `initdb` step (a few seconds).

## Capabilities

### New Capabilities
- `postgres-bundle`: a supervisor-managed, bundled Postgres database service (portable binaries shipped in the DMG/EXE, first-run `initdb` into a persistent data dir, `pg_ctl` lifecycle, `pg_isready` health check) that other bundled services (LiteLLM) depend on.

### Modified Capabilities
- `desktop-supervisor`: add Postgres to the bundled-services table; the supervisor starts/stops/health-checks it, assigns a free port, and starts it before LiteLLM (LiteLLM `dependsOn` postgres).
- `litellm-web`: replace the "open-in-new-tab link, no iframe" requirement with an **in-page embedded iframe** via `/litellm-web` (proxy the `/ui/*` SPA paths), now that the dashboard is functional with a DB.
- `litellm-provider`: LiteLLM is configured with a Postgres `DATABASE_URL` + `LITELLM_MASTER_KEY` + `LITELLM_SALT_KEY` (Prisma) so the admin UI initializes; the proxy starts after postgres.

## Impact

- **New**: `scripts/build-postgres.js` (per-platform binary download + checksum), a postgres supervisor descriptor + lifecycle (initdb/pg_ctl/pg_isready), `resources/postgres/`.
- **Modified**: `scripts/build-python-litellm.js` (prisma install + `prisma generate`), `supervisor/descriptors.js` (postgres descriptor + LiteLLM `dependsOn` + env), `local-services.js` + `electron/config/settings.js` (`SETTING_KEYS`: `DATABASE_URL`, `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`), `bootstrap/first-run.js` (salt-key generation), `server.js` (`/litellm-web` proxy `/ui/*` + `/api/config`), `web/src/pages/EmbeddedServicePages.tsx` (`LiteLLMPage` iframe), `package.json` (electron-builder `files`/`extraResources` + `platformBundles`), `.github/workflows/release.yml` (postgres build per matrix target), `litellm.yaml` (`database_url` + master/salt key refs).
- **Bundle size**: +~100-200 MB per platform (Postgres binaries). **First-run**: adds `initdb` (seconds). **License**: Postgres is PostgreSQL (PostgreSQL License) - redistributable.
