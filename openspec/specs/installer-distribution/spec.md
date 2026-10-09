# installer-distribution Specification

## Purpose

Distributes Platform desktop installers beyond GitHub: a plain-file HTTPS host for domestic downloads, a one-shot sync script that maps a GitHub Release into the official site's download-center snapshot and pushes artifacts to the host, beta promotion tied to real install smokes, and unsigned-install documentation. The snapshot shape is the cross-repo contract defined by the read side (fd-official-web `download-center`); this capability owns the write side.

## Requirements

### Requirement: Plain-file distribution host

The installer artifacts SHALL be served over HTTPS from `dl.finddatatech.cloud` as plain files from a static directory (Caddy on a cheap host), laid out as `/platform/<version>/<artifact>`. Artifacts SHALL be byte-identical to the GitHub Release assets of the same version. Distribution SHALL NOT bake artifacts into container images (per-version registry tags do not recycle quota). At least the two most recent published versions SHALL remain served; older versions MAY be pruned by the sync tooling.

#### Scenario: dl artifact matches the GitHub asset

- **WHEN** an artifact is fetched from `dl.finddatatech.cloud/platform/<version>/`
- **THEN** its digest equals the corresponding GitHub Release asset of that version

#### Scenario: Retention keeps the newest two versions

- **WHEN** the sync tooling publishes a new version with prune enabled
- **THEN** the two most recent version directories remain served and older ones are removed

### Requirement: release-sync one-shot chain

A single script SHALL map a GitHub Release (via `gh api`) into the official site's download-center snapshot and complete the distribution update: read the release and assets, map them to the snapshot entry (macos links the arm64 dmg + the Release page; windows links the exe directly; the x64 dmg rides to the host unlinked), validate the merged snapshot against the site's own build-time rules BEFORE any write, then commit and push the snapshot to both site remotes (triggering the site's image roll) and rsync the artifacts to the distribution host. Re-running the script for the same version SHALL be idempotent (same-version replace, no duplicate entries).

#### Scenario: A release becomes the live download band

- **WHEN** the script runs against a published `v<semver>` release
- **THEN** the site's snapshot gains the version entry and the site roll renders it
- **AND** the artifacts are served from the distribution host

#### Scenario: Invalid snapshot never reaches the site repo

- **WHEN** a mapped entry would fail the site's snapshot validation
- **THEN** the script fails before writing, committing, or pushing anything

### Requirement: Beta promotion discipline

A platform entry SHALL carry `beta: true` in the snapshot until an install smoke on a real machine of that platform has completed for that version; promotion to stable SHALL be a snapshot update recording the completed smoke. No platform SHALL be presented as stable on the official site before its smoke has passed.

#### Scenario: Windows ships beta until smoked

- **WHEN** a version publishes with no completed Windows install smoke
- **THEN** its `windows` snapshot entry carries `beta: true` and the download band marks it beta

#### Scenario: Smoke promotes to stable

- **WHEN** a Windows install smoke completes for that version
- **THEN** a snapshot update flips `beta` to `false` and the band presents it as stable after the roll

### Requirement: Unsigned installer documentation

The public repo README SHALL document that the installers are unsigned and the bypass steps for macOS Gatekeeper and Windows SmartScreen, and SHALL link the official site's download-band guidance; this documentation SHALL exist before any stable (non-beta) download link is published.

#### Scenario: README carries bypass guidance

- **WHEN** the public repo README renders
- **THEN** unsigned-install bypass steps for both macOS and Windows are present, linking the site's guidance

### Requirement: Assisted installer is explicitly configured
The Windows installer MUST be produced as an assisted (wizard) installer, with the NSIS options declared at the configuration top level rather than nested under a platform key.

#### Scenario: NSIS options live at the top level
- **WHEN** the packaging configuration is loaded
- **THEN** the NSIS block is a top-level configuration key
- **AND** the packager reads it (a block nested under the Windows platform key is silently ignored)

#### Scenario: Installer exposes directory choice, progress and completion
- **WHEN** the user runs the Windows installer
- **THEN** the installer presents a wizard with an installation-directory choice
- **AND** shows progress during unpacking
- **AND** shows a completion page
- **AND** allows canceling the installation

#### Scenario: Per-user install by default
- **WHEN** installing on Windows without a signed binary
- **THEN** the install targets the per-user location
- **AND** does not require elevation

### Requirement: Packaging closure covers runtime-only packages
The packaged app MUST contain every package the runtime resolves, including packages that the package manager installed as peers but that no manifest declares as a dependency.

#### Scenario: Peer-only runtime packages ship in the installer
- **WHEN** the agent runtime loads components that are declared only as peer dependencies
- **THEN** those components are present in the packaged app
- **AND** the runtime boots without a module-not-found failure

#### Scenario: Dynamically loaded runtime tree ships intact
- **GIVEN** the agent runtime resolves a large component tree from its own nested directory
- **WHEN** the app is packaged
- **THEN** that nested tree is copied into the package by an explicit resource declaration
- **AND** the packaged tree matches the development tree package-for-package

#### Scenario: Install resolves conflicting peer generations
- **WHEN** declared packages carry mutually incompatible peer ranges across two generations
- **THEN** installation proceeds with peer resolution relaxed
- **AND** the lockfile remains the source of truth for the resolved tree

### Requirement: Profile module links are maintained by the app
The app MUST ensure the agent profile can resolve its bare-specifier plugins on a machine that has no out-of-band provisioning.

#### Scenario: Bridge plugin dependencies are linked into the profile
- **WHEN** the app prepares the agent home
- **THEN** the packages the profile bridge plugins import are linked into the profile's module directory
- **AND** links point at the app's own copies

#### Scenario: Links do not shadow the runtime's own resolution
- **WHEN** linking packages for the profile
- **THEN** only the packages the bridges import are linked
- **AND** the runtime's own plugin names continue resolving from the runtime's own tree
- **AND** no link replaces a path the agent runtime itself manages

#### Scenario: Stale non-link entries are cleared before linking
- **GIVEN** a previous install left a real directory where the runtime expects a managed link
- **WHEN** the app prepares the agent home
- **THEN** the stale entry is removed and replaced by a link
- **AND** the runtime's boot does not abort with an ownership error

### Requirement: Readiness reflects the agent runtime
The readiness endpoint MUST report healthy only when the agent runtime actually initialized.

#### Scenario: A degraded agent keeps readiness unhealthy
- **WHEN** agent initialization fails but the server degrades instead of exiting
- **THEN** the readiness endpoint remains non-200
- **AND** the response exposes the initialization error
- **AND** readiness later follows runtime events as the runtime recovers or dies

#### Scenario: A healthy agent reports ready
- **WHEN** agent initialization succeeds
- **THEN** the readiness endpoint returns 200
