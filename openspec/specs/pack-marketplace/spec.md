# pack-marketplace Specification

## Purpose
A gateway-level registry where identity-gated creators publish versioned capability packs (skills + MCP references + agent personas) and every authenticated user can browse, inspect, and subscribe to them — the marketplace layer that makes packs shareable across users.

## Requirements

### Requirement: Publishing is identity-gated

Publishing SHALL be allowed only for authenticated users whose platform groups include the configured creator group (default `creators`), unless the deployment's access mode is `open`. The access mode SHALL be read from `PACK_ACCESS_MODE` with `closed` as the default; in `closed` mode the creator-group gate applies exactly as before (byte-identical refusals), and in `open` mode any authenticated user MAY publish — the creator group remains required for nothing on this path. Every other user SHALL receive a rejection. The gateway SHALL stamp the publishing user's identity and the publish time onto the stored version; the manifest itself SHALL NOT carry author-controlled identity claims. Both arrival surfaces — the cell-assembled flow on 壹座 and the publish-from-manifest flow on the facet surface — SHALL pass through the same gate and the same manifest validation.

#### Scenario: Creator publishes

- **WHEN** a user whose groups include `creators` submits a valid pack manifest to the publish endpoint
- **THEN** the pack is stored and the response returns its identifier and version

#### Scenario: Non-creator is rejected

- **WHEN** a user without the creator group submits a manifest to the publish endpoint in `closed` mode
- **THEN** the gateway rejects the request with an authorization error and stores nothing

#### Scenario: Manifest publish and cell-assembled publish share the gate

- **WHEN** the same creator publishes the same manifest shape via the facet console and via the 壹座 cell-assembled flow
- **THEN** both pass the identical identity gate and manifest validation, and both store versions stamped with the same author identity

#### Scenario: Open access mode admits any authenticated user

- **WHEN** `PACK_ACCESS_MODE=open` and a user without the creator group submits a valid manifest
- **THEN** the pack is stored under that user's identity — the same rate limiter, manifest validation, and tool gate apply unchanged

#### Scenario: Closed remains the default

- **WHEN** `PACK_ACCESS_MODE` is unset (or any value other than `open`) and a non-creator publishes
- **THEN** the refusal is byte-identical to the pre-change contract

### Requirement: Published versions are immutable

Each publish SHALL create a new immutable version of the pack with a monotonically increasing version number; published manifests SHALL never be modified afterward. Every stored version SHALL remain retrievable. An author MAY unpublish a pack, which unlists it (hidden from browse and detail for new fetches) but SHALL NOT alter or delete already-published versions or affect installed snapshots in subscribers' cells.

#### Scenario: Second publish bumps the version

- **WHEN** the author of an existing pack publishes a changed manifest
- **THEN** the pack gains a new version number and the previous version's manifest is unchanged and still retrievable

#### Scenario: Unpublish hides but does not destroy

- **WHEN** the author unpublishes a pack that subscribers have installed
- **THEN** the pack disappears from browse and detail for users who had not installed it
- **AND** subscribers' installed skills, MCP connections, and agents keep working unchanged

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). Unauthenticated visitors SHALL be able to list, search, inspect, and download the content of public packs without any account; private and unlisted packs SHALL remain invisible to them. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing. The detail view SHALL additionally render a usage-guide card when the client's guide content module contains an entry for that pack's id: the card presents the pack's three-step guide (prepare / ask / get) with the pack's own-language body content and i18n-resolved chrome labels. The card is informational only — a pack without guide content SHALL render the detail view exactly as before, with no guide card. The listing SHALL carry each pack's curation category and featured flag, and browsing SHALL offer filtering by category and a featured presentation (openspec: pack-marketplace, Packs carry a curation category and featured flag).

The detail view SHALL offer a version-history disclosure: an on-demand, lazily loaded list of the pack's published versions. The version list SHALL NOT be part of the default detail payload — it loads only when the viewer opens the disclosure. Each version row SHALL show the version number, publish time, publisher identity, the version's note when one is present, and links to that version's manifest snapshot and skill bodies. Version history SHALL follow the same visibility rules as the detail view itself: reachable anonymously for public packs, reachable to the owner (and admins) for their own private or unlisted packs, invisible otherwise. Historical versions are read-only: the disclosure offers inspection links only, never an install action for a non-latest version.

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

### Requirement: Manifest validation and limits

The publish endpoint SHALL validate the manifest shape and reject invalid publishes with a machine-readable reason: skill entries SHALL have well-formed unique names and bounded content; MCP entries SHALL be registry-name references only (any endpoint URL or command config SHALL be rejected); agent entries SHALL be persona-only (any endpoint, model, or credential reference SHALL be rejected) and their ids SHALL NOT fall under the `user.` prefix (reserved for the cell's custom presets — openspec: custom-presets); an agent entry's resource declaration SHALL name only skills and MCP references that the same manifest declares, with no duplicated names within one declaration (violations SHALL be rejected naming the role and entry); the manifest as a whole SHALL stay within per-pack size and count limits. A manifest MAY carry an optional top-level `notes` field — a string of at most 500 characters serving as the human-readable version note; a `notes` value that is not a string or exceeds the limit SHALL be rejected with a reason naming the field. Once published, the note is part of the immutable version (openspec: pack-marketplace, Published versions are immutable). The cell's install path SHALL enforce the same rules on the manifest it receives.

#### Scenario: MCP entry with an endpoint URL is rejected

- **WHEN** a publish contains an MCP entry carrying a `url` or command config
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Agent entry with an endpoint is rejected

- **WHEN** a publish contains an agent entry carrying `baseUrl`, `model`, or `apiKeyEnv`
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Oversized skill is rejected

- **WHEN** a publish contains a skill body exceeding the per-skill content limit
- **THEN** the publish is rejected with a reason naming the offending skill

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

### Requirement: Publish abuse controls

The publish endpoint SHALL apply per-author rate limiting and a request payload cap. Rejected or throttled publishes SHALL store nothing.

#### Scenario: Rapid publishes are throttled

- **WHEN** an author exceeds the per-author publish rate limit
- **THEN** further publishes are rejected with a throttling error and nothing is stored

### Requirement: Pack registry lives at the facet service

Published packs SHALL be stored in the independently deployed facet service's registry (openspec: facet-platform), separate from every cell's data and from 壹座's own state, keyed by an unguessable server-minted identifier carrying no author-identifying structure. A published pack SHALL remain listed and fetchable regardless of whether the author's cell is running and regardless of whether any 壹座 process is running. The identifier SHALL NOT be derived from the pack name or author identity.

#### Scenario: Pack outlives the author's cell

- **WHEN** a published pack's author has their cell stopped or reaped, or 壹座 itself is down, and another user browses the marketplace on the facet domain
- **THEN** the pack is listed and its manifest is fetchable exactly as before

#### Scenario: Pack identifier is unguessable

- **WHEN** a pack is published
- **THEN** the returned identifier is server-generated random with at least 96 bits of entropy and reveals nothing about the author or name without a registry lookup

### Requirement: Subscription records at the facet service

Subscribing and unsubscribing SHALL be recorded at the facet service keyed by the subscribing user's identity and the pack. These records power listing and count features; they are advisory for the subscriber's cell, whose own installed-pack state remains the operational truth for what is materialized there.

#### Scenario: Subscribe is recorded

- **WHEN** an authenticated user subscribes to a pack
- **THEN** a subscription record exists at the facet service for that user and pack with the subscribed version and time

#### Scenario: Author sees a subscriber count

- **WHEN** a creator opens the detail of their own published pack
- **THEN** the current subscriber count is visible

### Requirement: Preset-to-service one-click flow

壹座 SHALL offer a single user-initiated action from a cell's custom preset that composes the existing pieces — the preset-to-draft bridge, draft publish, and serving deploy — into one flow: the action presents the composed pack draft for confirmation (name, description, and an optional version note editable), publishes it as a new pack or a new version, and, when the resulting agent entry carries a serving contract, offers deploy as the final step of the same flow. Failure at any step SHALL stop the flow with the failed step named, and no later step SHALL run. The optional version note rides the publish under the same `notes` contract as the manifest field; an empty note publishes a manifest without the field.

#### Scenario: One action takes a preset to a published pack

- **WHEN** a user invokes the flow on their custom preset and confirms the composed draft
- **THEN** the pack is published and visible in the marketplace without the user visiting separate draft and publish surfaces

#### Scenario: Serving contract offers deploy in the same flow

- **WHEN** the flow publishes a pack whose agent entry carries a serving contract and the user chooses deploy
- **THEN** the deploy runs under the a2a-agent-serving deploy contract and the flow reports its result

#### Scenario: Failure stops with the failing step named

- **WHEN** any step of the flow fails (draft composition, publish, or deploy)
- **THEN** the flow stops with an error naming the failed step and no later step runs

#### Scenario: A version note rides the one-click publish

- **WHEN** the user fills the optional version note at the confirmation step and publishes
- **THEN** the published version carries the note and its version-history row shows it
- **AND** leaving the note empty publishes a manifest without a `notes` field

### Requirement: Claude marketplace manifest endpoint

The facet service SHALL serve a public, unauthenticated endpoint in the Claude Code plugin-marketplace format (`.claude-plugin/marketplace.json` semantics) that lists public curated packs as installable plugin entries. **Curated SHALL mean the pack carries a non-empty `category` or a true `featured` flag — the same curation signals the browse face consumes** — unless the operator whitelist (`FACET_MARKETPLACE_PACK_IDS`) is set, in which case the whitelist alone defines the listing (override semantics, applied instead of — not intersected with — the curation filter). Each entry SHALL expose the pack's skills as plugin skill content fetchable without an account; MCP references SHALL appear as connection guidance (endpoint and credential notice) only, and SHALL NOT be embedded as server configuration in the plugin body. Private and unlisted packs SHALL be absent. Uncurated public packs SHALL be absent from the listing while their plugin tree files remain fetchable by direct version URL (listing governs discovery, not access). The endpoint SHALL reflect the current listing state on refresh, with cache headers no longer than one hour.

#### Scenario: One command adds the marketplace

- **WHEN** a Claude Code user runs the plugin-marketplace add command against the facet endpoint
- **THEN** the marketplace is added and its curated packs are browsable and installable as plugins

#### Scenario: MCP stays guidance, never embedded server config

- **WHEN** a listed pack declares MCP server references
- **THEN** the plugin README SHALL carry connection guidance (endpoint and credential notice) only
- **AND** the plugin body SHALL NOT embed server configuration

#### Scenario: Non-public packs never appear

- **WHEN** a pack is private or unlisted
- **THEN** it SHALL be absent from the listing and its plugin tree files SHALL return not-found

#### Scenario: Uncurated public packs stay off the listing

- **WHEN** a public non-unlisted pack has an empty `category` and a false `featured` flag and no operator whitelist is set
- **THEN** the marketplace listing SHALL omit the pack
- **AND** its plugin tree files SHALL remain fetchable by direct version URL

#### Scenario: Operator whitelist overrides curation

- **WHEN** `FACET_MARKETPLACE_PACK_IDS` is set to a comma-separated list of pack ids
- **THEN** the listing SHALL contain exactly those packs that are public and non-unlisted
- **AND** packs on the whitelist SHALL be listed even without a category or featured flag
- **AND** the curation filter SHALL NOT further narrow the whitelist

### Requirement: The detail view renders the pack's guide with a manifest-first chain

The detail view's usage-guide card SHALL resolve its content in order: the pack's own `manifest.guide` when present, else the client guide content module for that pack id, else no card. The card's chrome labels SHALL resolve from the i18n bundle while step text renders as the creator's own-language content. When the client content module holds example prompts for the pack, the card SHALL additionally list up to four example questions (read-only text) beneath the steps; packs without example content show steps only. Neither the guide card nor the examples add any subscribe, install, or navigation action.

#### Scenario: manifest guide wins over client content

- **WHEN** a pack's manifest carries a guide and the client module also has content for its id
- **THEN** the detail view renders the manifest's three steps

#### Scenario: client module still covers launch packs

- **WHEN** a pack without a manifest guide has client-module content
- **THEN** the detail view renders the client module's steps as before

#### Scenario: example questions render when available

- **WHEN** the rendered pack has example prompts in the client content module
- **THEN** up to four example questions appear beneath the guide steps as read-only text

### Requirement: Subscribing ends with a next-steps wizard

The subscribe success report panel SHALL append a next-steps footer: a line naming the follow-up (open the conversation and pick this pack's expert), a button that navigates to the chat view, and a dismiss affordance equivalent to the report's existing close. The report's per-part statuses, masking, and close behavior (openspec: pack-installation) are unchanged. On the facet shell — where no conversation view exists — the next-steps footer SHALL not render, and the report panel itself SHALL be unchanged.

#### Scenario: the report offers the next step

- **WHEN** a subscription succeeds and the report panel renders on 壹座
- **THEN** the panel shows the next-steps footer with an open-chat button
- **AND** activating the button navigates to the chat view and dismisses the report

#### Scenario: the facet report ends without the wizard footer

- **WHEN** a subscription is recorded on the facet shell and the report panel renders
- **THEN** the report panel shows its per-part statuses and close affordance
- **AND** no next-steps footer or open-chat button renders

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
