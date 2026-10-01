# pack-marketplace Specification

## Purpose
A gateway-level registry where identity-gated creators publish versioned capability packs (skills + MCP references + agent personas) and every authenticated user can browse, inspect, and subscribe to them — the marketplace layer that makes packs shareable across users.

## Requirements

### Requirement: Pack registry lives at the gateway

Published packs SHALL be stored in a gateway-level registry separate from every cell's data, keyed by an unguessable server-minted identifier carrying no author-identifying structure. A published pack SHALL remain listed and fetchable regardless of whether the author's cell is running. The identifier SHALL NOT be derived from the pack name or author identity.

#### Scenario: Pack outlives the author's cell

- **WHEN** a published pack's author has their cell stopped or reaped and another user browses the marketplace
- **THEN** the pack is listed and its manifest is fetchable exactly as before

#### Scenario: Pack identifier is unguessable

- **WHEN** a pack is published
- **THEN** the returned identifier is server-generated random with at least 96 bits of entropy and reveals nothing about the author or name without a registry lookup

### Requirement: Publishing is identity-gated

Publishing SHALL be allowed only for authenticated users whose platform groups include the configured creator group (default `creators`). Every other user SHALL receive a rejection. The gateway SHALL stamp the publishing user's identity and the publish time onto the stored version; the manifest itself SHALL NOT carry author-controlled identity claims.

#### Scenario: Creator publishes

- **WHEN** a user whose groups include `creators` submits a valid pack manifest to the publish endpoint
- **THEN** the pack is stored and the response returns its identifier and version

#### Scenario: Non-creator is rejected

- **WHEN** a user without the creator group submits a manifest to the publish endpoint
- **THEN** the gateway rejects the request with an authorization error and stores nothing

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

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing.

#### Scenario: Search by tag

- **WHEN** a user searches the marketplace for the tag `法律`
- **THEN** the listing contains exactly the published packs tagged `法律`

#### Scenario: Skill bodies are inspectable before subscribe

- **WHEN** a user opens the detail view of a pack
- **THEN** every skill's full content, every MCP reference with its required group if any, and every agent entry are visible before any install happens

### Requirement: Manifest validation and limits

The publish endpoint SHALL validate the manifest shape and reject invalid publishes with a machine-readable reason: skill entries SHALL have well-formed unique names and bounded content; MCP entries SHALL be registry-name references only (any endpoint URL or command config SHALL be rejected); agent entries SHALL be persona-only (any endpoint, model, or credential reference SHALL be rejected) and their ids SHALL NOT fall under the `user.` prefix (reserved for the cell's custom presets — openspec: custom-presets); an agent entry's resource declaration SHALL name only skills and MCP references that the same manifest declares, with no duplicated names within one declaration (violations SHALL be rejected naming the role and entry); the manifest as a whole SHALL stay within per-pack size and count limits. The cell's install path SHALL enforce the same rules on the manifest it receives.

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

### Requirement: Subscription records at the gateway

Subscribing and unsubscribing SHALL be recorded at the gateway keyed by the subscribing user's identity and the pack. These records power listing and count features; they are advisory for the subscriber's cell, whose own installed-pack state remains the operational truth for what is materialized there.

#### Scenario: Subscribe is recorded

- **WHEN** an authenticated user subscribes to a pack
- **THEN** a subscription record exists at the gateway for that user and pack with the subscribed version and time

#### Scenario: Author sees a subscriber count

- **WHEN** a creator opens the detail of their own published pack
- **THEN** the current subscriber count is visible

### Requirement: Publish abuse controls

The publish endpoint SHALL apply per-author rate limiting and a request payload cap. Rejected or throttled publishes SHALL store nothing.

#### Scenario: Rapid publishes are throttled

- **WHEN** an author exceeds the per-author publish rate limit
- **THEN** further publishes are rejected with a throttling error and nothing is stored
