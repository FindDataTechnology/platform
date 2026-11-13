# pack-marketplace delta

## ADDED Requirements

### Requirement: Listing and detail carry the official badge

The listing and latest-version detail SHALL carry an `official` flag, derived server-side from the
deployment's official-author roster (openspec: official-pack-showcase) — never from any author-declared
manifest field. The flag is presentation-level: it SHALL NOT affect visibility, immutability,
installability, or pricing. Browsing SHALL offer an official filter; the facet market list and the
壹座 pre-login showcase consume the same flag.

#### Scenario: Official author's pack is badged

- **WHEN** the roster contains an author and that author's public pack is listed
- **THEN** the listing row and detail carry `official: true`, with no change to any other field

#### Scenario: Roster change re-derives the flag

- **WHEN** an operator removes an author from the roster
- **THEN** that author's packs read `official: false` on the next listing read, with no write to packs.db

#### Scenario: Flag never gates anything

- **WHEN** a pack's official flag flips in either direction
- **THEN** its visibility, versions, installability, and curation state are exactly as before
