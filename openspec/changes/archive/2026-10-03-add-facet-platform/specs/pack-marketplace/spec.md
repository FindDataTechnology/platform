## REMOVED Requirements

### Requirement: Pack registry lives at the gateway
**Reason**: 市场归属迁至独立部署的 facet 服务（谦面），gateway/server 进程不再是 pack 注册处的宿主。
**Migration**: 由 ADDED「Pack registry lives at the facet service」接替；已发布 pack 的 id、版本、清单经 packs.db 迁移原样保留，无重编号。

### Requirement: Subscription records at the gateway
**Reason**: 订阅记录随市场库一并归属 facet 服务。
**Migration**: 由 ADDED「Subscription records at the facet service」接替；记录键（用户身份 × pack）不变，历史记录随库迁移保持连续。

## MODIFIED Requirements

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). Unauthenticated visitors SHALL be able to list, search, inspect, and download the content of public packs without any account; private and unlisted packs SHALL remain invisible to them. The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing.

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

## ADDED Requirements

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

壹座 SHALL offer a single user-initiated action from a cell's custom preset that composes the existing pieces — the preset-to-draft bridge, draft publish, and serving deploy — into one flow: the action presents the composed pack draft for confirmation (name and description editable), publishes it as a new pack or a new version, and, when the resulting agent entry carries a serving contract, offers deploy as the final step of the same flow. Failure at any step SHALL stop the flow with the failed step named, and no later step SHALL run.

#### Scenario: One action takes a preset to a published pack

- **WHEN** a user invokes the flow on their custom preset and confirms the composed draft
- **THEN** the pack is published and visible in the marketplace without the user visiting separate draft and publish surfaces

#### Scenario: Serving contract offers deploy in the same flow

- **WHEN** the flow publishes a pack whose agent entry carries a serving contract and the user chooses deploy
- **THEN** the deploy runs under the a2a-agent-serving deploy contract and the flow reports its result

#### Scenario: Failure stops with the failing step named

- **WHEN** any step of the flow fails (draft composition, publish, or deploy)
- **THEN** the flow stops with an error naming the failed step and no later step runs
