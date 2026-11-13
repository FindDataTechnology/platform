# release-pipeline delta

## Purpose

Adds the distribution-facing contract to the build pipeline: attached release asset names are machine-mappable to distribution platforms, because the snapshot writeback tooling (installer-distribution) resolves platforms purely by asset-name patterns.

## ADDED Requirements

### Requirement: Machine-mappable release assets

The release pipeline's attached asset names SHALL remain machine-mappable to distribution platforms: `Platform-<version>-arm64.dmg` and `Platform-<version>-x64.dmg` (macOS arm64/x64) and `Platform Setup <version>.exe` (Windows x64). Any change to the artifact-naming configuration SHALL be treated as a contract change and made in the same pass as the distribution snapshot tooling that parses it.

#### Scenario: Assets map to snapshot platforms without manual mapping

- **WHEN** a Release is published and its assets are listed
- **THEN** every asset name matches one of the mappable patterns, and the sync tooling resolves the `macos`/`windows` snapshot entries from the asset list alone
