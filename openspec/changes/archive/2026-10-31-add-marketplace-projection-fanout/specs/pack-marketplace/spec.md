## ADDED Requirements

### Requirement: Every market projection shares one admission rule

All marketplace-shaped projections of the pack catalog (the Claude-format marketplace endpoint, the CodeBuddy/WorkBuddy repository, the MCP Registry `server.json` projection, and any future public-market shape) SHALL derive their admission from a single shared source rather than re-implementing the rule per surface.

For pack listings, admission SHALL remain: public, non-unlisted, and curated (`category` non-empty or `featured` true), unless the operator whitelist (`FACET_MARKETPLACE_PACK_IDS`) is set, in which case the whitelist alone defines the listing. For MCP-server projections, admission SHALL remain: enabled and carrying no required groups. A new projection surface SHALL consume these rules and SHALL NOT introduce a second copy, so that two market surfaces can never disagree about what is listed.

#### Scenario: Two surfaces cannot disagree

- **WHEN** a pack is public, non-unlisted, and curated
- **THEN** it appears on every enabled market surface that admits packs
- **AND** when it is unlisted or private it is absent from all of them

#### Scenario: New surface reuses the rule

- **WHEN** a new market projection surface is added
- **THEN** its listing is computed through the shared admission source
- **AND** no surface-specific admission filter that diverges from the shared rule is introduced
