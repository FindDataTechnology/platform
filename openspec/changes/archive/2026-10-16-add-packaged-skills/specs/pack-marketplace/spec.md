# pack-marketplace — Delta

## MODIFIED Requirements

### Requirement: Manifest validation and limits

The publish endpoint SHALL validate the manifest shape and reject invalid publishes with a machine-readable reason: skill entries SHALL have well-formed unique names and bounded content; a skill entry MAY carry an auxiliary file set (relative path to text content) and a stored frontmatter object, admitted under the platform's package contract — paths that escape the skill directory, non-text file kinds, file names colliding with the rendered skill document under case-insensitive filesystems, an auxiliary file beyond the per-file bound, or an aggregate beyond the per-skill bound (file count or total size) are each rejected naming the offending entry; MCP entries SHALL be registry-name references only (any endpoint URL or command config SHALL be rejected); agent entries SHALL be persona-only (any endpoint, model, or credential reference SHALL be rejected) and their ids SHALL NOT fall under the `user.` prefix (reserved for the cell's custom presets — openspec: custom-presets); an agent entry's resource declaration SHALL name only skills and MCP references that the same manifest declares, with no duplicated names within one declaration (violations SHALL be rejected naming the role and entry); the manifest as a whole SHALL stay within per-pack size and count limits. A manifest MAY carry an optional top-level `notes` field — a string of at most 500 characters serving as the human-readable version note; a `notes` value that is not a string or exceeds the limit SHALL be rejected with a reason naming the field. Once published, the note is part of the immutable version (openspec: pack-marketplace, Published versions are immutable). The cell's install path SHALL enforce the same rules on the manifest it receives.

#### Scenario: MCP entry with an endpoint URL is rejected

- **WHEN** a publish contains an MCP entry carrying a `url` or command config
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Agent entry with an endpoint is rejected

- **WHEN** a publish contains an agent entry carrying `baseUrl`, `model`, or `apiKeyEnv`
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Oversized skill is rejected

- **WHEN** a publish contains a skill body exceeding the per-skill content limit
- **THEN** the publish is rejected with a reason naming the offending skill

#### Scenario: Path-escaping auxiliary file is rejected

- **WHEN** a publish contains a skill entry whose auxiliary file set carries a path with `..` segments or an absolute path
- **THEN** the publish is rejected with a reason naming the offending skill and path

#### Scenario: Oversized auxiliary file is rejected

- **WHEN** a publish contains a skill entry with an auxiliary file beyond the per-file size bound
- **THEN** the publish is rejected with a reason naming the offending skill and file

#### Scenario: Auxiliary aggregate bound is enforced

- **WHEN** a publish contains a skill entry whose auxiliary file set exceeds the per-skill file-count or total-size bound
- **THEN** the publish is rejected with a reason naming the offending skill and the exceeded bound

#### Scenario: Skill-document name collision is rejected

- **WHEN** a publish contains a skill entry whose auxiliary file set carries a file whose name is a case variant of the skill document's own name
- **THEN** the publish is rejected with a reason naming the offending skill and file

#### Scenario: Role declaration naming an undeclared resource is rejected

- **WHEN** a publish contains an agent entry whose resource declaration names a skill or MCP reference not present in the manifest's own lists
- **THEN** the publish is rejected with a reason naming the role and the unknown name

#### Scenario: Duplicated declaration entry is rejected

- **WHEN** a role's resource declaration lists the same skill or MCP name twice
- **THEN** the publish is rejected with a reason naming the role and the duplicate

#### Scenario: Reserved-prefix agent id is rejected

- **WHEN** a publish contains an agent entry whose id starts with `user.`
- **THEN** the publish is rejected with a reason naming the entry and the reserved namespace

#### Scenario: Oversized version notes are rejected

- **WHEN** a publish carries a `notes` value longer than 500 characters
- **THEN** the publish is rejected with a machine-readable reason naming the `notes` field, and nothing is stored

#### Scenario: Non-string version notes are rejected

- **WHEN** a publish carries a `notes` value that is not a string
- **THEN** the publish is rejected with a machine-readable reason naming the `notes` field, and nothing is stored

#### Scenario: Notes are optional

- **WHEN** a publish carries no `notes` field
- **THEN** the publish proceeds exactly as before, and the version renders with no note

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). Unauthenticated visitors SHALL be able to list, search, inspect, and download the content of public packs without any account; private and unlisted packs SHALL remain invisible to them. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing; a skill's auxiliary file set SHALL be represented in the detail payload as its file inventory (relative paths), with every file's content fetchable on demand under the same visibility rules as the detail view itself — nothing installed by the pack is hidden from inspection, and no auxiliary content rides the default payload. The detail view SHALL additionally render a usage-guide card when the client's guide content module contains an entry for that pack's id: the card presents the pack's three-step guide (prepare / ask / get) with the pack's own-language body content and i18n-resolved chrome labels. The card is informational only — a pack without guide content SHALL render the detail view exactly as before, with no guide card. The listing SHALL carry each pack's curation category and featured flag, and browsing SHALL offer filtering by category and a featured presentation (openspec: pack-marketplace, Packs carry a curation category and featured flag).

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

## ADDED Requirements

### Requirement: Files-bearing publishes are operator-gated

The facet service SHALL gate publishes whose manifests carry auxiliary file sets behind an explicit operator switch (`PACK_FILES_ENABLED`, default off). While the switch is off, such a publish SHALL be rejected with a clear reason; publishes without auxiliary files are unaffected in either switch state. The switch exists to protect cells running pre-package validators, which accept unknown manifest keys silently — the gate turns a rolling-deploy window of silently degraded installs into an explicit enable decision.

#### Scenario: Gate off rejects files-bearing publish

- **WHEN** `PACK_FILES_ENABLED` is unset or false and a publish carries a skill entry with auxiliary files
- **THEN** the publish is rejected with a reason naming the gate, and nothing is stored

#### Scenario: Gate on admits files-bearing publish

- **WHEN** `PACK_FILES_ENABLED` is true and a publish carries a skill entry with a valid auxiliary file set
- **THEN** the publish proceeds under the manifest validation rules

#### Scenario: Files-free publishes are never gated

- **WHEN** `PACK_FILES_ENABLED` is off and a publish carries no auxiliary file sets
- **THEN** the publish proceeds exactly as before

### Requirement: Tree skills are never served as a degraded single document

The facet's public single-document skill endpoint (the anonymous per-skill raw markdown route that registry skill registration validates against) SHALL refuse a skill whose entry carries auxiliary files, with an explicit error stating that the skill contains auxiliary files and is not registrable as a single document. Per-file reads under the detail view's visibility rules remain the inspection path for tree skills. A silently degraded, files-dropped twin SHALL never be produced by any marketplace read surface.

#### Scenario: Raw-md endpoint refuses a tree skill

- **WHEN** an anonymous caller fetches the raw markdown route of a skill whose entry carries auxiliary files
- **THEN** the endpoint returns an explicit error naming the auxiliary-files cause, not a body-only document

#### Scenario: Single-file skill keeps serving raw markdown

- **WHEN** an anonymous caller fetches the raw markdown route of a skill without auxiliary files
- **THEN** the endpoint serves the body with synthesized frontmatter exactly as before
