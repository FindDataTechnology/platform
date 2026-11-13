## ADDED Requirements

### Requirement: Publish returns a self-hosted pack to the official market

The CLI SHALL provide a `publish` command that transports a pack manifest to the official facet market — from a local manifest file, or pulled from the pack's public detail on a self-hosted instance — authenticating through the device-pairing surface on the market's own domain. The CLI SHALL add no gate of its own: creator gating, manifest validation, tool-declaration gating, and author rate limiting all run on the market exactly as for a web publish, and the CLI SHALL surface their verdicts verbatim. Access tokens SHALL live only in process memory; the persisted pairing state SHALL be the device identity (id, keypair, paired account) and the source-to-official pack id mapping.

#### Scenario: Publish from a local manifest file

- **WHEN** `facet publish <path.json>` runs with a paired identity whose account is a creator
- **THEN** the manifest file is POSTed to the market's publish route and the new pack id and version are printed

#### Scenario: Cross-instance pull and push

- **WHEN** `facet publish <packRef> --from <self-hosted base>` runs and the pack is public on the source instance
- **THEN** the CLI pulls the stored manifest (including skill content) from the source instance's public detail and publishes it to the official market under the paired account's authorship

#### Scenario: Pairing on demand via bind code

- **WHEN** publish runs with no paired identity for the market domain (or the pairing was revoked)
- **THEN** the CLI prints and opens the market's bind-code page, reads a 6-digit code from stdin, pairs the device, and continues the publish

#### Scenario: Silent re-login on every run

- **WHEN** a paired device runs publish
- **THEN** the CLI silently logs in through the single-use challenge before publishing and stores no token on disk

#### Scenario: Validation errors pass through verbatim

- **WHEN** the market rejects the manifest
- **THEN** the CLI prints the market's validation errors item by item and stores nothing

#### Scenario: Creator gate refusal is surfaced with guidance

- **WHEN** the paired account is not in a creator group
- **THEN** the CLI reports the market's 403 with guidance that the paired account needs creator membership, and does not retry

#### Scenario: Source-to-official id mapping is remembered

- **WHEN** a first publish of a source pack succeeds and a later publish of the same source pack runs without `--pack-id`
- **THEN** the CLI reuses the remembered official id to append a new version; if that official pack no longer exists, the CLI reports the market's error instead of silently double-publishing
