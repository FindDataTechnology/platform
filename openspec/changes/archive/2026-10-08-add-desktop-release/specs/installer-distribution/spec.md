# installer-distribution Specification

## Purpose

Distributes Platform desktop installers beyond GitHub: a plain-file HTTPS host for domestic downloads, a one-shot sync script that maps a GitHub Release into the official site's download-center snapshot and pushes artifacts to the host, beta promotion tied to real install smokes, and unsigned-install documentation. The snapshot shape is the cross-repo contract defined by the read side (fd-official-web `download-center`); this capability owns the write side.

## ADDED Requirements

### Requirement: Plain-file distribution host

The installer artifacts SHALL be served over HTTPS from `dl.finddatatech.cloud` as plain files from a static directory (Caddy on a cheap host), laid out as `/platform/<version>/<artifact>`. Artifacts SHALL be byte-identical to the GitHub Release assets of the same version. Distribution SHALL NOT bake artifacts into container images (per-version registry tags do not recycle quota). At least the two most recent published versions SHALL remain served; older versions MAY be pruned by the sync tooling.

#### Scenario: dl artifact matches the GitHub asset

- **WHEN** an artifact is fetched from `dl.finddatatech.cloud/platform/<version>/`
- **THEN** its digest equals the corresponding GitHub Release asset of that version

#### Scenario: New version lands in its own directory

- **WHEN** a new version's artifacts are synced
- **THEN** they appear under `/platform/<version>/` and prior versions' paths are untouched

#### Scenario: Old versions pruned only beyond the retention floor

- **WHEN** pruning removes an old version
- **THEN** the two most recent published versions remain served and the removed version's path returns 404

### Requirement: release-sync one-shot chain

A sync script (`scripts/release-sync.mjs` in the platform repo) SHALL take a version tag and: read the GitHub Release and its assets via API; map assets to the download-center snapshot schema (`schema: 1`, releases newest-first, platform keys `macos`/`windows`; asset mapping — macOS: the arm64 `.dmg` as the direct/official artifact and the Release page as the GitHub link, Windows: the `.exe` for both sources); validate the resulting snapshot locally against the site's rules (missing/malformed known fields, unknown platform keys, linkless platform entries are errors); write it into the fd-official-web repo's `src/data/desktop-releases.json` and commit+push (which triggers the site roll); then rsync the artifacts to the dl host. The chain SHALL be re-runnable and converge (one entry per version, idempotent rsync), and SHALL fail at the offending step without committing a snapshot that would fail the site's build validation.

#### Scenario: Fresh sync produces a valid snapshot

- **WHEN** release-sync runs for a published GitHub Release
- **THEN** the written snapshot passes the site's build-time validation and the rolled site renders that version in the download band

#### Scenario: Re-run converges

- **WHEN** release-sync runs again for the same tag
- **THEN** the snapshot holds exactly one entry for that version and the rsync transfers nothing new

#### Scenario: Invalid snapshot never committed

- **WHEN** the mapped snapshot would violate the site's validation rules
- **THEN** the script fails before any commit and names the offending entry and field

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
