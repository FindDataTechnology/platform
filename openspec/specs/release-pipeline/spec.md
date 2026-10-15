# release-pipeline Specification

## Purpose

Builds and publishes Platform desktop installers from CI: a self-sufficient clean-checkout build (bundled Node produced by scripts, asserted present), a mac arm64/x64 + Windows x64 matrix, tag-triggered GitHub Releases, secret-gated signing/notarization, and cost-conscious caching. Asset names are machine-mappable to distribution platforms because the snapshot writeback tooling (installer-distribution) resolves platforms purely by asset-name patterns.

## Requirements
### Requirement: Clean-checkout build is self-sufficient
The release pipeline SHALL build a working desktop installer from a fresh checkout with no pre-existing `resources/` directory and no hand-placed binaries. Every bundled resource SHALL be produced by a build script invoked during `predist` and asserted present by `verify-bundle.js`. `resources/node` SHALL always be built.

#### Scenario: Fresh checkout builds the macOS installer
- **WHEN** a clean checkout is built on a macOS arm64 runner
- **THEN** `predist` produces `resources/node`
- **AND** `verify-bundle.js` passes asserting it is present
- **AND** `npm run dist` produces a `.dmg`

#### Scenario: Bundled Node is reproducibly built
- **WHEN** `resources/node/` is absent
- **THEN** `scripts/build-node.js` downloads the standalone Node for the host platform
- **AND** `verify-bundle.js` fails the build if the platform-correct Node binary is missing

### Requirement: Platform matrix build
The release pipeline SHALL build the macOS (arm64 + x64) and Windows installers as parallel matrix jobs. The macOS x64 build runs on the arm64 runner via Rosetta (`setup-node architecture: x64`), so `npm ci` compiles native addons for the x64 ABI and `build-node.js` (arch-aware via `process.arch`) fetches the x64 asset. The arch is selected per job by the `--arm64`/`--x64` flag (no `mac.target.arch` config list, which would make every job build all archs).

#### Scenario: macOS arm64 job builds the dmg
- **WHEN** the matrix job for `macos-latest` arm64 runs
- **THEN** it builds with the arm64 standalone Node
- **AND** produces the `Platform-<version>-arm64.dmg`

#### Scenario: macOS x64 job builds the dmg via Rosetta
- **WHEN** the matrix job for `macos-latest` x64 runs
- **THEN** it installs Rosetta and sets up x64 Node
- **AND** builds with the x64 standalone Node
- **AND** produces the `Platform-<version>-x64.dmg`

#### Scenario: Windows x64 job builds the exe
- **WHEN** the matrix job for `windows-latest` runs
- **THEN** it builds with the Windows x64 standalone Node
- **AND** produces the `Platform Setup <version>.exe` (NSIS)

### Requirement: Bundled Node ABI matches the install-time Node ABI
Because native addons run under the bundled standalone Node with `npmRebuild: false`, the bundled Node SHALL be the same version as the Node that ran `npm ci`, so the compiled `.node` files (`better-sqlite3`, `tree-sitter`, `fsevents`) load without rebuild. `build-node.js` SHALL achieve this by downloading the standalone Node matching `process.version` (the Node running the build), making the invariant hold automatically in every environment.

#### Scenario: Bundled Node matches the build-time Node
- **WHEN** the workflow sets up Node (via `setup-node`) and runs `predist`
- **THEN** `build-node.js` downloads the standalone Node whose version equals the running `process.version`
- **AND** that version is the same one `npm ci` compiled the native addons against
- **AND** the bundled Node therefore loads `better-sqlite3`/`tree-sitter`/`fsevents` without rebuild

### Requirement: Tag-triggered release
The release pipeline SHALL publish a GitHub Release with all installers (mac arm64 + x64 + win) attached when a `v*` tag is pushed, and SHALL also support an on-demand (`workflow_dispatch`) build that uploads artifacts without cutting a release.

#### Scenario: Tag push creates a release
- **WHEN** a tag matching `v*` is pushed
- **THEN** all matrix jobs build their installer
- **AND** a GitHub Release is created (or updated) with the `.dmg` and `.exe` attached

#### Scenario: Manual dispatch uploads artifacts
- **WHEN** the workflow is run via `workflow_dispatch`
- **THEN** the installers are built and uploaded as workflow artifacts
- **AND** no GitHub Release is created

### Requirement: Signing and notarization gated on secrets
The release pipeline SHALL sign and notarize the installers when the required secrets are present, and SHALL produce a successful unsigned build when they are absent. A missing certificate SHALL NOT fail a CI build. Notarization SHALL use electron-builder's built-in `mac.notarize` (delegating to `@electron/notarize`) which skips with a warning when the `APPLE_*` env vars are absent.

#### Scenario: Secrets present - signed release
- **WHEN** `CSC_LINK` + `CSC_KEY_PASSWORD` are set on macOS (signing) and `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` are set (notarization), and `WIN_CSC_LINK` on Windows
- **THEN** the macOS app is signed and notarized
- **AND** the Windows installer is signed
- **AND** (once entitlements for the bundled Node are added) the signed macOS app passes Gatekeeper

#### Scenario: Secrets absent - unsigned build succeeds
- **WHEN** no signing secrets are set
- **THEN** electron-builder skips signing and notarization with warnings (not errors)
- **AND** the build completes successfully
- **AND** produces an unsigned `.dmg` / `.exe` usable for internal/CI smoke testing

### Requirement: Build caching for cost and reproducibility
The release pipeline SHALL cache the `resources/` directory (keyed by OS and `platformBundles`) and the electron-builder cache, so that repeated builds do not re-download the standalone Node. The `resources/` cache key SHALL additionally hash `platform.bundle.json` and the resource build scripts, so a change to either never restores a stale cache.

#### Scenario: Cached resources are reused
- **WHEN** a second build runs on the same OS with unchanged `platformBundles`
- **THEN** `predist` skips rebuilding already-present `resources/`

#### Scenario: Build-script change invalidates the cache
- **WHEN** a resource build script or `platform.bundle.json` changes
- **THEN** the resources cache key differs and the cache is not restored
- **AND** `predist` rebuilds `resources/` from scratch

### Requirement: Machine-mappable release assets

The release pipeline's attached asset names SHALL remain machine-mappable to distribution platforms: `Platform-<version>-arm64.dmg` and `Platform-<version>-x64.dmg` (macOS arm64/x64) and `Platform Setup <version>.exe` (Windows x64). Any change to the artifact-naming configuration SHALL be treated as a contract change and made in the same pass as the distribution snapshot tooling that parses it.

#### Scenario: Assets map to snapshot platforms without manual mapping

- **WHEN** a Release is published and its assets are listed
- **THEN** every asset name matches one of the mappable patterns, and the sync tooling resolves the `macos`/`windows` snapshot entries from the asset list alone

### Requirement: Install smoke verifies what the user sees
The Windows install smoke MUST assert that the installed app renders content, not merely that its processes and ports respond.

#### Scenario: Installed app is launched as a GUI and proves rendering
- **WHEN** the smoke runs the installed app on a Windows runner
- **THEN** the app is launched with its self-test enabled
- **AND** the smoke waits for the app to exit and asserts a zero exit status
- **AND** the self-test report is surfaced in the build log

#### Scenario: A non-rendering window fails the smoke
- **WHEN** the app exits non-zero from its self-test
- **OR** the app never completes its self-test within the deadline
- **THEN** the smoke job fails
- **AND** the failure names the missing rendering

#### Scenario: Evidence is preserved for human review
- **WHEN** the self-test finishes, pass or fail
- **THEN** its report and screenshot are uploaded as build artifacts

### Requirement: Install smoke probes the renderer's target address
The smoke MUST probe the exact address the app window loads, in addition to any backend-level probe.

#### Scenario: Window URL is probed on the desktop port
- **WHEN** the app has launched its backend
- **THEN** the smoke requests the app's window URL on the desktop port
- **AND** requires a 200 before continuing

#### Scenario: Direct backend probe uses the variables the backend reads
- **WHEN** the smoke runs the packaged backend directly
- **THEN** it sets the port and bind-address variables that the backend process actually reads
- **AND** probes that same address
- **AND** a mismatched variable name cannot produce a guaranteed-false-negative timeout

### Requirement: External screenshots are not trusted as rendering evidence
The pipeline MUST NOT treat a display-wide screenshot of the runner desktop as proof that the application window rendered.

#### Scenario: Wallpaper-dominated capture is recognized as invalid
- **GIVEN** a captured image of the runner desktop
- **WHEN** the pixels that differ from the app backdrop come from the desktop wallpaper
- **THEN** that capture is not accepted as evidence of rendering
- **AND** the app's own renderer capture is used instead
