## MODIFIED Requirements

### Requirement: Publishing is identity-gated

Publishing SHALL be allowed only for authenticated users whose platform groups include the configured creator group (default `creators`). Every other user SHALL receive a rejection. The gateway SHALL stamp the publishing user's identity and the publish time onto the stored version; the manifest itself SHALL NOT carry author-controlled identity claims. Both arrival surfaces — the cell-assembled flow on 壹座 and the publish-from-manifest flow on the facet surface — SHALL pass through the same gate and the same manifest validation.

#### Scenario: Creator publishes

- **WHEN** a user whose groups include `creators` submits a valid pack manifest to the publish endpoint
- **THEN** the pack is stored and the response returns its identifier and version

#### Scenario: Non-creator is rejected

- **WHEN** a user without the creator group submits a manifest to the publish endpoint
- **THEN** the gateway rejects the request with an authorization error and stores nothing

#### Scenario: Manifest publish and cell-assembled publish share the gate

- **WHEN** the same creator publishes the same manifest shape via the facet console and via the 壹座 cell-assembled flow
- **THEN** both pass the identical identity gate and manifest validation, and both store versions stamped with the same author identity

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). Unauthenticated visitors SHALL be able to list, search, inspect, and download the content of public packs without any account; private and unlisted packs SHALL remain invisible to them. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing. The detail view SHALL additionally render a usage-guide card when the client's guide content module contains an entry for that pack's id: the card presents the pack's three-step guide (prepare / ask / get) with the pack's own-language body content and i18n-resolved chrome labels. The card is informational only — a pack without guide content SHALL render the detail view exactly as before, with no guide card. The listing SHALL carry each pack's curation category and featured flag, and browsing SHALL offer filtering by category and a featured presentation (openspec: pack-marketplace, Packs carry a curation category and featured flag).

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

#### Scenario: Filtering by curation category

- **WHEN** a visitor filters the market listing by a category
- **THEN** only packs whose curation category matches are listed, and featured packs appear in the featured rail first

## ADDED Requirements

### Requirement: Packs carry a curation category and featured flag

Each pack SHALL carry a curation category (a short slug, empty when uncategorized) and a featured flag (default not featured). The author MAY declare the category at publish time or from the creator console; admins MAY change both at any time through the curation endpoint. The category and featured flag SHALL be carried by the listing, the latest-version detail, and the Claude plugin marketplace face. Curation state SHALL be presentation-level only: it SHALL NOT affect visibility, immutability of published versions, or installability.

#### Scenario: Admin sets category and feature

- **WHEN** an admin sets a pack's category and features it via the curation endpoint
- **THEN** the listing and detail carry the new category and featured state, and the pack's visibility and versions are unchanged

#### Scenario: Author-declared category rides the publish

- **WHEN** a creator publishes a manifest that declares a category
- **THEN** the stored pack carries that category without any admin action

#### Scenario: Curation never hides or exposes

- **WHEN** a pack is featured or recategorized
- **THEN** its public/private/unlisted visibility semantics are exactly as before curation
