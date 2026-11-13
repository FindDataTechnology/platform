## MODIFIED Requirements

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). Unauthenticated visitors SHALL be able to list, search, inspect, and download the content of public packs without any account; private and unlisted packs SHALL remain invisible to them. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing. The detail view SHALL additionally render a usage-guide card when the client's guide content module contains an entry for that pack's id: the card presents the pack's three-step guide (prepare / ask / get) with the pack's own-language body content and i18n-resolved chrome labels. The card is informational only — a pack without guide content SHALL render the detail view exactly as before, with no guide card.

#### Scenario: Search by tag

- **WHEN** a user searches the marketplace for the tag `法律`
- **THEN** the listing contains exactly the published packs tagged `法律` visible to that user

#### Scenario: Skill bodies are inspectable before subscribe

- **WHEN** a user opens the detail view of a pack
- **THEN** every skill's full content, every MCP reference with its required group if any, and every agent entry are visible before any install happens

#### Scenario: Anonymous visitors see public packs only

- **WHEN** an unauthenticated visitor browses or searches the marketplace, opens a public pack's detail, or downloads a skill body
- **THEN** public packs are listed, inspectable, and downloadable without a credential
- **AND** private packs and unlisted packs are absent from every response

#### Scenario: Guide card renders for a covered pack

- **WHEN** the user opens the detail view of a pack whose id has guide content in the client content module
- **THEN** the detail view SHALL show the usage-guide card with the pack's three-step guide
- **AND** the card SHALL offer no subscribe, install, or navigation actions

#### Scenario: No card for uncovered packs

- **WHEN** the user opens the detail view of a pack without guide content
- **THEN** the detail view SHALL render exactly as before, with no guide card
