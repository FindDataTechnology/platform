# pack-marketplace Specification (delta)

## MODIFIED Requirements

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). Unauthenticated visitors SHALL be able to list, search, inspect, and download the content of public packs without any account; private and unlisted packs SHALL remain invisible to them. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing; a skill's auxiliary file set SHALL be represented in the detail payload as its file inventory (relative paths), with every file's content fetchable on demand under the same visibility rules as the detail view itself — nothing installed by the pack is hidden from inspection, and no auxiliary content rides the default payload. The detail view SHALL additionally render a usage-guide card when the client's guide content module contains an entry for that pack's id: the card presents the pack's three-step guide (prepare / ask / get) with the pack's own-language body content and i18n-resolved chrome labels. The card is informational only — a pack without guide content SHALL render the detail view exactly as before, with no guide card. The listing SHALL carry each pack's curation category and featured flag, and browsing SHALL offer filtering by category and a featured presentation (openspec: pack-marketplace, Packs carry a curation category and featured flag). Listing summaries SHALL additionally carry `agentCount` (the latest version's declared agent count), and browsing SHALL offer an agent-count filter (1 / 2-3 / 4+) whose state lives in the `agents` URL query parameter; summaries without an agent count pass through unfiltered. When a pack's manifest declares `cluster` metadata, the detail view SHALL render a cluster section — cluster name, description, member count, the default members, and a toggle revealing the optional members (openspec: marketplace-cluster-view); packs without cluster metadata render exactly as before.

The detail view SHALL offer a version-history disclosure: an on-demand, lazily loaded list of the pack's published versions. The version list SHALL NOT be part of the default detail payload — it loads only when the viewer opens the disclosure. Each version row SHALL show the version number, publish time, publisher identity, the version's note when one is present, and links to that version's manifest snapshot and skill bodies. Version history SHALL follow the same visibility rules as the detail view itself: reachable anonymously for public packs, reachable to the owner (and admins) for their own private or unlisted packs, invisible otherwise. Historical versions are read-only: the disclosure offers inspection links only, never an install action for a non-latest version.

#### Scenario: Search by tag

- **WHEN** a user searches the marketplace for the tag `法律`
- **THEN** the listing contains exactly the published packs tagged `法律` visible to that user

#### Scenario: Skill bodies are inspectable before subscribe

- **WHEN** a user opens the detail view of a pack
- **THEN** every skill's full content, every MCP reference with its required group if any, and every agent entry are visible before any install happens

#### Scenario: File inventory rides the detail, contents load on demand

- **WHEN** a user opens the detail view of a pack whose skill carries five auxiliary files
- **THEN** the detail payload lists the five file paths for that skill and does not inline their contents
- **AND** each file's content is fetchable on demand with the detail view's own visibility, including anonymously for public packs

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

#### Scenario: Version history loads on demand and stays out of the default payload

- **WHEN** a viewer opens a public pack's detail view
- **THEN** the version-history disclosure is present but its content is not yet fetched, and the default detail payload carries no version list
- **AND** opening the disclosure loads the versions, each row showing version number, publish time, publisher, note when present, and manifest/skill links for that version

#### Scenario: Version history is anonymously reachable for public packs

- **WHEN** an unauthenticated visitor opens the version-history disclosure of a public pack
- **THEN** the version list and every per-version link resolve without a credential

#### Scenario: Version history respects pack visibility

- **WHEN** a pack is private or unlisted
- **THEN** its version history is reachable only by the owner (and admins), consistent with the detail view's visibility rules

#### Scenario: History is inspect-only

- **WHEN** a viewer opens the version-history disclosure of any pack
- **THEN** the rows offer inspection links only, with no install action for a non-latest version

#### Scenario: Agent-count filter narrows the listing

- **WHEN** a visitor selects the 2-3 agents bucket
- **THEN** only packs whose latest version declares two or three agents are listed, and a refresh keeps the bucket via `?agents=`

#### Scenario: Cluster section on a cluster pack's detail

- **WHEN** a user opens the detail view of a pack whose manifest declares `cluster`
- **THEN** the view shows the cluster name, description, member count, and default members, with the optional members behind a toggle
