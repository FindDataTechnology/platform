## ADDED Requirements

### Requirement: Continuous integration runs all offline gates on every pull request
The project SHALL provide a GitHub Actions workflow triggered on `pull_request` (any branch) and `push` to `main` that runs, in order: lint (Biome), typecheck (`web/` `tsc --noEmit`), unit tests (`test:unit`), locale parity (`check:locales`), production web build (`web:build`), and the offline E2E `fast` Playwright project. Every step MUST complete without secrets, network access to paid LLM gateways, or reachability of the deployed live service.

#### Scenario: pull request opens
- **WHEN** a pull request is opened or updated
- **THEN** the CI workflow SHALL run all six gates sequentially and report a combined status

#### Scenario: push to main
- **WHEN** a commit is pushed to `main`
- **THEN** the CI workflow SHALL run the same six gates

### Requirement: CI environment matches the toolchain constraints
The CI workflow SHALL install Node 25 and npm 11 (lockfile requirement), skip `postinstall` resource building via `PLATFORM_SKIP_WEB_BUILD=1` and `PLATFORM_SKIP_BUNDLE=1`, build `web/dist` explicitly before E2E, and install Playwright's chromium browser.

#### Scenario: clean runner checkout
- **WHEN** CI runs on a fresh GitHub-hosted runner
- **THEN** `npm ci` SHALL succeed without cloning or downloading bundled resources
- **AND** `web/dist` SHALL be built by an explicit workflow step before E2E starts

### Requirement: Type errors block the build
The `web/` package SHALL provide a `typecheck` script running `tsc --noEmit`, and CI SHALL run it as a gate independent of `vite build` (which does not typecheck). The typecheck gate SHALL pass on `main` (including `web/src/components/Composer.tsx`).

#### Scenario: type error introduced in a PR
- **WHEN** a pull request contains TypeScript that fails `tsc --noEmit`
- **THEN** the CI typecheck step SHALL fail the workflow

### Requirement: Lint gate
The project SHALL include a configured linter (Biome) with correctness rules enabled for root JavaScript and `web/` TypeScript/TSX, runnable via a single `npm run lint` script, green on `main`.

#### Scenario: lint detects a correctness issue
- **WHEN** a pull request introduces code that trips a Biome correctness rule
- **THEN** the CI lint step SHALL fail the workflow

### Requirement: Unit tests are machine-independent
All unit tests (`scripts/test-*.mjs`) SHALL resolve dependencies through repo-relative paths, with no absolute paths tied to a specific developer machine. `npm run test:unit` SHALL pass on a clean checkout on any machine.

#### Scenario: fresh clone
- **WHEN** a developer clones the repository to an arbitrary path and runs `npm run test:unit`
- **THEN** all unit tests SHALL pass without module-not-found errors
