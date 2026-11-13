## ADDED Requirements

### Requirement: Bundled Postgres binaries are built and packaged
The project SHALL bundle portable Postgres binaries (`bin/`, `lib/`, `share/`) for mac arm64, mac x64, and win x64 into `resources/postgres/` via `scripts/build-postgres.js` (downloaded from the `@embedded-postgres/*` npm tarballs, SHA512-verified against the npm registry, skip-if-built). The mac binaries SHALL be universal (one tarball covers arm64 + x64). The binaries SHALL be included in the DMG/EXE via `electron-builder.yml` `extraResources` (`resources/postgres/ -> postgres/`). The Postgres version SHALL be pinned in `package.json` `platformBundles.postgresVersion`.

#### Scenario: build script produces relocatable binaries per platform
- **WHEN** `npm run predist` runs on a mac or windows CI runner
- **THEN** `scripts/build-postgres.js` downloads the platform-correct `@embedded-postgres` tarball, verifies its SHA512, and extracts `bin/`, `lib/`, `share/` into `resources/postgres/`
- **AND** the binaries SHALL be relocatable (no hardcoded prefix; postgres auto-resolves `../lib` and `../share`)

#### Scenario: binaries are packaged in the installer
- **WHEN** `npm run dist` produces the DMG/EXE
- **THEN** the installer SHALL include `resources/postgres/{bin,lib,share}` at `<app>/Resources/postgres/`

### Requirement: Postgres data directory is persistent and update-safe
The Postgres data directory (created by `initdb`) SHALL live under `PLATFORM_DATA_DIR/postgres-data` (resolved via `paths.js` `storeDir`), NOT inside the read-only app bundle. It SHALL persist across app updates and SHALL NOT be recreated on each launch (`initdb` runs only when the directory is missing).

#### Scenario: data dir under PLATFORM_DATA_DIR
- **WHEN** the supervisor starts bundled Postgres
- **THEN** the data directory SHALL resolve to `PLATFORM_DATA_DIR/postgres-data` (or `postgres-data` relative to CWD in dev)
- **AND** SHALL survive an app update

### Requirement: Postgres starts on a free localhost port with trust auth
The supervisor SHALL run `initdb --auth=trust -U postgres` on first start, then start Postgres on a free localhost port with `listen_addresses=localhost`. Postgres SHALL NOT listen on a fixed port or on external interfaces. LiteLLM SHALL use the default `postgres` database (the `@embedded-postgres` package ships only `initdb`/`pg_ctl`/`postgres` - no `createdb`/`psql`), so no extra database is created.

#### Scenario: first start initializes the data dir
- **WHEN** bundled Postgres starts and the data dir does not exist
- **THEN** the supervisor runs `initdb -D <dataDir> --auth=trust -U postgres`
- **AND** starts Postgres on a free localhost port

#### Scenario: subsequent starts reuse the data dir
- **WHEN** bundled Postgres starts and the data dir exists
- **THEN** the supervisor skips `initdb` and starts Postgres reusing the existing data

### Requirement: macOS bundled Postgres binaries are codesigned
On macOS, the bundled `postgres`, `initdb`, `pg_ctl` binaries and `lib/postgresql/*.dylib` SHALL be codesigned with the app's identity (Hardened Runtime) during the build, so a notarized app bundle remains valid. When signing secrets are absent, the build SHALL still succeed unsigned (Gatekeeper warning only).

#### Scenario: signed binaries in a notarized build
- **WHEN** `npm run dist` runs with signing secrets configured
- **THEN** the postgres binaries + dylibs SHALL be signed with the app identity
