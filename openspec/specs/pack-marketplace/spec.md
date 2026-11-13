# pack-marketplace Specification

## Purpose
A gateway-level registry where identity-gated creators publish versioned capability packs (skills + MCP references + agent personas) and every authenticated user can browse, inspect, and subscribe to them — the marketplace layer that makes packs shareable across users.

## Requirements

### Requirement: Publishing is identity-gated

Publishing SHALL be allowed for authenticated users who satisfy at least one of: platform groups include the configured creator group (default `creators`); the deployment's access mode is `open`; or the user is bound to a registered vendor whose profile mandatory fields are complete (openspec: vendor-identity). The access mode SHALL be read from `PACK_ACCESS_MODE` with `closed` as the default; in `open` mode any authenticated user MAY publish, in `closed` mode admission is the creator group OR a registered vendor binding. Every other user SHALL receive a rejection. The gateway SHALL stamp the publishing user's identity and the publish time onto the stored version; the manifest itself SHALL NOT carry author-controlled identity claims (vendor attribution rides the stamped identity, not the manifest text — see the vendor-attribution requirement in this capability). Both arrival surfaces — the cell-assembled flow on 壹座 and the publish-from-manifest flow on the facet surface — SHALL pass through the same gate and the same manifest validation, and every publish-side rule (rate limiter, manifest validation, tool-surface closure gate) SHALL apply to vendor publishers identically: no lane is relaxed for vendors.

#### Scenario: Creator publishes

- **WHEN** a user whose groups include `creators` submits a valid pack manifest to the publish endpoint
- **THEN** the pack is stored and the response returns its identifier and version

#### Scenario: Non-creator is rejected

- **WHEN** a user with neither the creator group nor a registered vendor binding submits a manifest to the publish endpoint in `closed` mode
- **THEN** the gateway rejects the request with an authorization error and stores nothing

#### Scenario: Bound vendor publishes

- **WHEN** a user bound to a registered vendor with a complete profile submits a valid pack manifest in `closed` mode
- **THEN** the pack is stored and the stamped identity records the vendor attribution input for the attribution requirement to resolve

#### Scenario: Vendor with incomplete profile is rejected at the gate

- **WHEN** a vendor-bound user whose profile mandatory fields are incomplete submits a manifest
- **THEN** the gateway rejects with the eligibility classification naming the missing profile fields and stores nothing

#### Scenario: Manifest publish and cell-assembled publish share the gate

- **WHEN** the same publisher (creator or bound vendor) publishes the same manifest shape via the facet console and via the 壹座 cell-assembled flow
- **THEN** both pass the identical identity gate and manifest validation, and both store versions stamped with the same author identity

#### Scenario: Open access mode admits any authenticated user

- **WHEN** `PACK_ACCESS_MODE=open` and a user with neither creator group nor vendor binding submits a valid manifest
- **THEN** the pack is stored under that user's identity — the same rate limiter, manifest validation, and tool gate apply unchanged

#### Scenario: Closed remains the default

- **WHEN** `PACK_ACCESS_MODE` is unset (or any value other than `open`) and a non-creator without a vendor binding publishes
- **THEN** the refusal is byte-identical to the pre-change contract

#### Scenario: Publish-side rules hold identically for vendors

- **WHEN** a bound vendor's pack declares a tool surface that fails the closure gate or exceeds rate limits
- **THEN** the refusal classification and shape are identical to those a creator would receive

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

### Requirement: Manifest validation and limits

The publish endpoint SHALL validate the manifest shape and reject invalid publishes with a machine-readable reason: skill entries SHALL have well-formed unique names and bounded content; a skill entry MAY carry an auxiliary file set (relative path to text content) and a stored frontmatter object, admitted under the platform's package contract — paths that escape the skill directory, non-text file kinds, file names colliding with the rendered skill document under case-insensitive filesystems, an auxiliary file beyond the per-file bound, or an aggregate beyond the per-skill bound (file count or total size) are each rejected naming the offending entry; MCP entries SHALL be registry-name references only (any endpoint URL or command config SHALL be rejected); agent entries SHALL be persona-only (any endpoint, model, or credential reference SHALL be rejected) and their ids SHALL NOT fall under the `user.` prefix (reserved for the cell's custom presets — openspec: custom-presets); an agent entry's resource declaration SHALL name only skills and MCP references that the same manifest declares, with no duplicated names within one declaration (violations SHALL be rejected naming the role and entry); the manifest as a whole SHALL stay within per-pack size and count limits. A manifest MAY carry an optional top-level `notes` field — a string of at most 500 characters serving as the human-readable version note; a `notes` value that is not a string or exceeds the limit SHALL be rejected with a reason naming the field. Once published, the note is part of the immutable version (openspec: pack-marketplace, Published versions are immutable). The cell's install path SHALL enforce the same rules on the manifest it receives.

Every rejection SHALL identify the offending location in a form the creating surface can turn into a jump target (a field path or entry name), and the creating surface SHALL render the refusals as locatable rows rather than one summary sentence. The rejection conditions themselves SHALL NOT change: the checklist presentation is the same gate, not a second one, and a refusal added by a new gate SHALL appear in the list without any other change.

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

#### Scenario: Every refusal is locatable

- **WHEN** a publish is refused for two independent violations
- **THEN** the response carries both with their offending field paths or entry names, and the creating surface can render them as two rows

#### Scenario: Presentation cannot relax the gate

- **WHEN** the creating surface shows no pending items and the server still refuses
- **THEN** the refusal stands and names its location; the surface must surface that row rather than reporting success

#### Scenario: A new gate appears in the list without special-casing

- **WHEN** a publish is refused by a gate added after this change
- **THEN** its refusal is rendered with the same locatable shape, and nothing else in the surface changes

### Requirement: Publish abuse controls

The publish endpoint SHALL apply per-author rate limiting and a request payload cap. Rejected or throttled publishes SHALL store nothing. The publish gate SHALL additionally reject a same-name republish: a publish whose author already has a live (listed or unlisted) pack under the same name SHALL be rejected with a structured error that names the existing pack's identifier and the upgrade path (publish a new version under that identifier) — the gate creates no second registry entry for one author and one name. Administrative cleanup of pre-existing same-name duplicates SHALL go through the management face (unlist/retire), not through a publish-side exemption.

#### Scenario: Rapid publishes are throttled

- **WHEN** an author exceeds the per-author publish rate limit
- **THEN** further publishes are rejected with a throttling error and nothing is stored

#### Scenario: Same-name republish is rejected

- **WHEN** an author publishes a manifest named 柏讯 · 预期差 while their earlier pack under that exact name exists
- **THEN** the publish is rejected, nothing is stored, and the error names the existing pack's identifier and how to publish a new version instead

#### Scenario: Same name under a different author is allowed

- **WHEN** a different author publishes a pack whose name collides with another author's pack name
- **THEN** the publish proceeds (the guard is per-author, name collisions across authors are a curation matter)

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

The subscribe success report panel SHALL append a next-steps footer that takes the user straight into a conversation with what they just installed — no manual re-selection step:

- 单角色功能集：footer 的按钮 SHALL 携带该功能集默认角色的 agent 标识导航到
  `/chat?preset=<agentId>`（openspec: web-chat-ui, 非 embed 导航的预设深链），
  对话页在连接就绪后自动选中该角色；hint 文案 SHALL 不再指示用户手动去
  「上方选择框」选人。
- 多角色且声明集群元数据的功能集：footer SHALL 以「去对话并载入整组」为
  主按钮，导航携带该集群的 lead 角色标识与整组载入意图，落地后按既有动态
  集群路径绑定会话并切到 lead（openspec: agent-preset-selection, 统一的
  「与谁对话」选人面）；无可用 lead（如全部角色安装失败）时按钮退化为普通
  「打开对话」。
- 无角色条目的功能集（纯技能/工具包）：footer 保持普通「打开对话」按钮
  （裸导航），hint 说明能力已就绪。

footer 保留与报告一致的关闭（dismiss）语义；报告本身的逐部件状态、脱敏与
关闭行为（openspec: pack-installation）不变。On the facet shell — where no
conversation view exists — the next-steps footer SHALL not render, and the
report panel itself SHALL be unchanged.

#### Scenario: the report offers the next step

- **WHEN** a subscription succeeds for a single-role pack and the report panel renders on 壹座
- **THEN** the panel shows the next-steps footer with an open-chat button carrying `preset=<default agentId>`
- **AND** activating the button navigates to `/chat?preset=<agentId>`, dismisses the report, and the chat auto-selects that role once connected

#### Scenario: cluster pack offers load-the-group

- **WHEN** a subscription succeeds for a pack declaring cluster metadata with a lead role
- **THEN** the footer's primary button is 「去对话并载入整组」 and lands the chat with the cluster bound to the session and the lead role active

#### Scenario: skill-only pack keeps plain navigation

- **WHEN** a subscription succeeds for a pack with no agent entries
- **THEN** the footer shows a plain open-chat button with no `preset` parameter

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

### Requirement: The pack detail dialog carries an always-visible action bar

The pack detail dialog SHALL render its primary actions in a bar flush to the dialog's bottom edge — always visible regardless of the content scroll position, opaque, with the scrolling content ending above it (no see-through gap at any scroll position) — carrying the subscribe-and-install primary button and a visible close affordance. The former in-content action placement (the subscribe button at the end of the scrolling flow) SHALL be replaced by this bar. The bar's optional "go to my packs" affordance is host-selected: hosts pass it only where an installed-packs management surface exists (壹座); hosts without one (the facet shell) omit it. An explicit close control SHALL be present in the bar in addition to the existing overlay/Escape dismissal.

#### Scenario: the bar is visible without scrolling

- **WHEN** a visitor opens a pack whose detail content exceeds the dialog's scroll height
- **THEN** the action bar with the subscribe button and the close control is visible immediately, without scrolling

#### Scenario: the close control dismisses the dialog

- **WHEN** the visitor activates the bar's close control
- **THEN** the dialog closes exactly as the overlay or Escape dismissal does

#### Scenario: the facet dialog carries no goto-mine affordance

- **WHEN** the facet shell opens the pack detail dialog
- **THEN** the action bar shows the subscribe button and the close control and no "go to my packs" button

#### Scenario: the close control sits at the dialog's top-right

- **WHEN** the dialog renders
- **THEN** the close control is positioned at the dialog's top-right corner — the conventional spot — and dismisses in one step

#### Scenario: scrim click dismisses in one step

- **WHEN** the visitor clicks the overlay while the dialog is open
- **THEN** the dialog closes (a two-step scrim confirm was tried and reverted — the plain dismissal is the product call)

#### Scenario: the signed-out viewer's goto-mine flips the guidance row

- **WHEN** a host wires both the signed-out signal and the goto-mine affordance and a signed-out visitor activates goto-mine
- **THEN** the login guidance row appears (no silent no-op, no navigation)

#### Scenario: a signed-in viewer's gated buttons fire for real

- **WHEN** the host reports a signed-in viewer
- **THEN** the signed-out path is not wired, and subscribe and goto-mine execute their normal behavior (no login redirect)

### Requirement: Anonymous subscribe attempts get a login guidance bar

When the host reports a signed-out viewer, activating the subscribe-and-install button SHALL NOT emit a raw error: the action bar SHALL surface an inline guidance row — a localized line stating that subscribing and installing require signing in, plus a sign-in action that navigates to the host's login entry (the facet shell: `/auth/login` with a same-origin return path back to the packs market, per the service's existing safe-return handling). Hosts that do not wire the signed-out signal keep the existing authenticated-error fallback unchanged (壹座 users always hold a session; that path is an edge state there, and its error text SHALL be localized rather than raw English).

#### Scenario: anonymous click surfaces the guidance row

- **WHEN** a signed-out visitor activates the subscribe-and-install button on the facet shell
- **THEN** the action bar shows the localized guidance row with a sign-in action, and no raw English error text renders

#### Scenario: sign-in returns to the packs market

- **WHEN** the visitor follows the guidance row's sign-in action and completes login
- **THEN** they land back on the packs market view (`#/packs`)

#### Scenario: hosts without the signal keep their fallback

- **WHEN** the dialog renders on a host that does not pass the signed-out signal and a subscribe call fails with an authentication error
- **THEN** the dialog shows a localized authentication guidance message in its error surface, unchanged in behavior otherwise

### Requirement: The deploy section explains itself in plain language

The pack detail dialog's deploy-as-a-service section SHALL open with a plain-language summary stating what deploying yields (the pack's agents go live as a conversation service: a shareable public chat page, per-round metering, deployer revenue share), and each of its subsections SHALL carry a one-line plain-language subtitle — the metering-key area (whose quota pays for visitor rounds), the rhythm area (whether the platform wakes the agent to act on its own schedule; no entries means it only answers when addressed), the model area (which model the agent thinks with; empty keeps the standing setting — an existing override, else the pack's declared default), and the budget area (the longest a single round may run; empty keeps the standing setting — an existing override, else the declared ceiling or the platform default). The deploy button's outcome expectation (deploying produces a shareable conversation page) SHALL be stated at the button. These explanations are presentation-level: the section's data behavior, permissions, and deploy semantics are exactly as before (openspec: pack-marketplace, deploy requirements; the section stays fully previewable to signed-out visitors).

#### Scenario: the section summary names the outcome

- **WHEN** the deploy section renders
- **THEN** it opens with the plain-language summary of what deploying yields before any control

#### Scenario: subsections carry their subtitles

- **WHEN** the deploy section renders with its metering-key, rhythm, model, and budget areas
- **THEN** each area carries its one-line plain-language subtitle

#### Scenario: the deploy button states its result

- **WHEN** the deploy section renders its deploy button
- **THEN** the expected outcome (a shareable conversation page) is stated adjacent to the button

### Requirement: The deploy form offers deploy-time model and budget choices

The pack detail dialog's deploy-as-a-service section SHALL offer, for each serving-contract agent, a model input and a turn-budget input alongside the existing rhythm override — the deployer composes the deployment's initial service configuration (openspec: a2a-agent-serving, deploy requirements; agent-service-config) in one place instead of deploying first and editing on the serving config surface afterwards. Empty inputs SHALL mean "change nothing on this dimension": a deploy request omits the agent from its model and budget maps entirely, and the deployment's effective values then follow the standing precedence — an existing override preserved from the prior deployment when redeploying (openspec: agent-service-config, upgrade overlay semantics), else the manifest's declaration, else the platform default — byte-identical to the behavior before this form existed. There is no clear-back semantics at deploy time: the form never sends a null (clearing an existing override is the serving config surface's act, not the deploy form's). A filled model input SHALL ride the deploy request as the agent's deploy-time model choice, passing the same write-time validation gates (declared whitelist, billing lanes, runner roster) the deploy action already enforces; a filled budget input SHALL ride as the agent's per-turn budget override under the platform's budget rule (positive whole minutes within the platform cap).

The form SHALL validate the budget input client-side under the platform's budget rule and refuse to submit while it is invalid, naming the rule — a server round-trip must not be the first place a typo meets its error. Model inputs SHALL NOT be client-side lane-validated (lanes are a property of the bound billing key, unknowable in the form before deployment); a declared `modelWhitelist` in the serving contract SHALL surface as autocomplete options with the whitelist named in a hint, and the absence of a whitelist SHALL surface a hint that the choice is validated against the billing key's lanes at submit. A declared serving model or budget ceiling SHALL be visible as the input's placeholder so the deployer sees what an empty input yields. Deploy failures from the model gates SHALL surface as a localized guidance message, never raw transport English.

#### Scenario: The form renders model and budget inputs per serving agent

- **WHEN** the deploy section renders for a pack with a serving-contract agent
- **THEN** the agent's row offers a model input and a turn-budget input next to its rhythm override, each with a plain-language label

#### Scenario: Empty inputs ride no maps and change nothing

- **WHEN** the deployer submits with the model and budget inputs empty — on a first deploy or a redeploy of a pack whose deployment already carries overrides
- **THEN** the deploy request carries no model or budget maps for the agent, and the effective values follow the standing precedence (preserved override when one exists, else the declaration, else the platform default) exactly as before this form existed

#### Scenario: A filled model rides the deploy request and the gate error is localized

- **WHEN** the deployer fills a model and submits, and the choice is refused by a model gate (whitelist, billing lanes, or runner roster)
- **THEN** the deploy section surfaces a localized message naming the refusal, and no deployment is created

#### Scenario: The declared whitelist narrows and explains the input

- **WHEN** the serving contract declares a `modelWhitelist`
- **THEN** the model input offers the whitelist's entries as autocomplete options and names them in its hint

#### Scenario: An invalid budget never leaves the form

- **WHEN** the budget input holds a value that is not a positive whole number of minutes within the platform cap
- **THEN** the deploy button's submission is refused in the form with a message naming the rule, and no deploy request is sent

#### Scenario: The declared default is visible without filling anything

- **WHEN** the serving contract declares a model (or a budget ceiling) and the deploy section renders
- **THEN** the corresponding input's placeholder shows the declared value, so an empty input's effect is visible before submit

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

### Requirement: Manifests can be validated without publishing

The facet service SHALL expose a manifest validation endpoint that accepts the same request body as publishing a pack and returns the verdict publishing would return, without performing the publish. Validation SHALL be available to any authenticated caller regardless of creator-group membership; lack of publish eligibility SHALL be reported as a caller finding, not as a rejection. A validation call SHALL NOT mint a pack id or version, SHALL NOT persist any record, and SHALL NOT consume any publish-rate budget.

#### Scenario: Non-creator validates a sound manifest

- **WHEN** an authenticated caller outside the creators group submits a manifest that passes every publish gate
- **THEN** the endpoint returns success with `valid: true`, no manifest errors, and a caller finding stating that the caller cannot publish yet

#### Scenario: Invalid manifest gets publish-identical errors

- **WHEN** a submitted manifest fails structural limits, the files gate, or the tool-declaration gate
- **THEN** the endpoint reports `valid: false` with error wording identical to the corresponding publish rejection

#### Scenario: Registry unreachable during tool verification

- **WHEN** the manifest declares tool names and the registry index cannot be reached to verify them
- **THEN** the endpoint reports `valid: false` with the same fail-closed message publishing would return, and no verdict of validity is implied

#### Scenario: Continuation to an existing pack is checked read-only

- **WHEN** the request carries a pack id for a new version and the caller is not the pack's author, or the pack does not exist
- **THEN** the endpoint reports the same outcome publishing would report, without creating or modifying any version

#### Scenario: Validation is side-effect free

- **WHEN** the same manifest is validated repeatedly
- **THEN** no pack record or version is created and the author's publish budget is unchanged

#### Scenario: Anonymous callers are rejected

- **WHEN** an unauthenticated request hits the validation endpoint
- **THEN** it is rejected with the same authentication failure as the other pack write endpoints

### Requirement: The detail view discloses each MCP reference's tool face

The pack detail view SHALL render, for every MCP reference of the published version, the tool face the pack actually mounts: for an allowlisted reference, the declared tool count against the server's catalog-served total (for example "6 / 161 工具"); for a `fullSurface` reference, the server's full tool count together with the author's stated reason. A version published before the explicit-declaration gate — carrying neither — SHALL render as the full surface, marked as undeclared.

The disclosure SHALL be derived from the immutable version manifest plus the catalog's `tool_list`; it SHALL NOT require a live call to the server.

#### Scenario: Allowlisted reference shows declared versus total

- **WHEN** a user opens the detail view of a pack whose `fd-daas-mcp` reference declares 5 tools
- **THEN** the view shows 5 against the catalog's total for that server, and no reason line

#### Scenario: Full-surface reference shows its reason

- **WHEN** a pack marks `law-bench` full-surface with a reason
- **THEN** the detail view shows the server's full tool count and the reason text

#### Scenario: Legacy version renders as undeclared full surface

- **WHEN** a published version predates the gate and its reference carries no declaration
- **THEN** the view shows the full tool count marked as undeclared, and the page still renders normally

### Requirement: Both surfaces share a type scale and spacing discipline

The two market surfaces — the facet standalone shell (`facet/web/src`) and the 壹座 embedded Store (`web/src/components/packs/`) — SHALL follow one type-scale discipline: body and explanatory text renders at `text-xs` (12px) or larger; sub-12px sizes are permitted only for non-prose micro-labels (version chips, badge numerals) and only in monospace single-line form, with the permitted inventory recorded in the shared design doc (`facet/web/DESIGN.md`). Spacing SHALL come from the semantic Tailwind scale; arbitrary-value spacing is permitted only for data-driven dimensions recorded in the same doc. The shared design doc SHALL be the single source of truth for this discipline and for the state-pattern and motion vocabulary both surfaces use.

#### Scenario: no eyeballed type sizes in prose

- **WHEN** either surface renders a paragraph, hint, or list of explanatory text
- **THEN** its font size comes from the semantic scale at 12px or larger — no `text-[9px]`, `text-[10px]`, or `text-[11px]` on prose

#### Scenario: micro-labels stay within the recorded inventory

- **WHEN** a sub-12px size is used anywhere on either surface
- **THEN** the element is a non-prose micro-label listed in the DESIGN.md inventory, rendered monospace single-line

#### Scenario: async views on both surfaces share the state pattern

- **WHEN** the 壹座 Store's market tab loads packs, or the facet shell's packs view loads packs
- **THEN** both render the same shape of skeleton/empty/error states defined by the shared design doc

### Requirement: The 壹座 Store tab carries a market guide entry

On the 壹座 pack market surface — the market tab of the 智能体市场 surface at `/agents?tab=market`, the product's single in-product pack doorway; `/packs` redirects into this same tab so an old bookmark lands on the same facet line and is never left with a context-free dock — the copilot dock SHALL resolve the facet line's focused assistant (existing `GET /api/boards/facet/copilot` resolution, no new endpoint) and open the guide with that preset injected — same open/restore semantics as the board path. While the guide is open, the surface SHALL publish the currently inspected pack (from the detail dialog's lifecycle) into the guide's context bar via the existing same-origin postMessage channel; the injection SHALL be read-only (the embed registers no page-action handler, and any write intent SHALL still travel through the action gate's propose path). The dock SHALL follow the surface across its tabs, and SHALL keep working on pack detail dialogs opened from either of the surface's two tabs (`market` and `mine`): the same focused-assistant resolution, the same inspected-pack publication, and the same read-only injection SHALL hold on both, because a pack detail dialog can be opened from a listed pack and from an installed snapshot alike. When the facet assistant pack is not installed (no resolvable focused preset), the surface SHALL surface an honest hint pointing at the assistant's market entry instead of an unfocused guide pretending to be gated. The facet standalone site (anonymous surface) carries no guide entry in this scope.

#### Scenario: opening the guide from the Market tab injects the focused preset

- **WHEN** a signed-in user on `/agents?tab=market` opens the copilot dock and the 谦面助手 pack is installed
- **THEN** the guide session runs under the `facet-assistant` focused preset and the context bar names it

#### Scenario: the inspected pack reaches the guide's context

- **WHEN** the pack detail dialog is open and the user asks the guide a question
- **THEN** the guide's context bar shows the current pack and the answer may reference it

#### Scenario: the dock follows the surface to the mine tab

- **WHEN** the user opens a pack detail dialog from the installed snapshots under `/agents?tab=mine` and asks the guide a question
- **THEN** the guide's context bar shows that inspected pack, and the injection stays read-only exactly as on the market tab

#### Scenario: write intent stays gated

- **WHEN** the user asks the guide to subscribe to the inspected pack
- **THEN** the turn surfaces an action proposal card (propose/confirm/audit), never a direct subscription

#### Scenario: honest degradation without the assistant pack

- **WHEN** the 谦面助手 pack is not installed on the cell
- **THEN** the Market tab shows the guidance hint toward the assistant's market entry and the guide does not claim a focused preset

#### Scenario: the standalone site carries no guide

- **WHEN** an anonymous visitor browses the facet standalone site
- **THEN** no guide entry appears (the anonymous-surface guide is out of scope)

### Requirement: Marketplace hygiene baseline

The public marketplace listing SHALL NOT present packs whose purpose is acceptance-testing, internal demo, or deployment verification; such packs SHALL be carried as unlisted (versions stay immutable and fetchable — an existing subscriber is never broken by hygiene actions, and unlisting SHALL NOT delete any version). Every public pack SHALL carry a curation category (empty only while triage is in flight); bringing the existing catalog up to this baseline is an operational task, not a code path. Duplicate-domain content (two live packs from the same author covering the same domain) SHALL be converged to a single line by the author or an admin via the management face — the publish guard prevents new duplicates, the management face retires old ones. Re-listing SHALL be reachable by the pack's author through the ordinary publish path: publishing a new version of an unlisted pack SHALL restore its listing in the same operation, so an unlisted pack is never stranded and no operator database access is required to bring it back. Publishing SHALL NOT flip a pack's visibility class (public/private) — it clears the unlisted flag only.

#### Scenario: Demo pack is unlisted, not deleted

- **WHEN** an admin unlists an acceptance-demo pack
- **THEN** it disappears from the public listing while its published versions remain fetchable by prior subscribers and the pack can be re-listed later

#### Scenario: A new version restores listing

- **WHEN** the author of an unlisted pack publishes its next version
- **THEN** the new version is appended, the pack's unlisted flag clears, and the pack reappears in the public listing

#### Scenario: A non-author cannot restore listing by publishing

- **WHEN** anyone other than the pack's author attempts to publish a version against an unlisted pack
- **THEN** the publish is rejected as forbidden and the pack stays unlisted

#### Scenario: Publishing never changes visibility class

- **WHEN** a private pack's author publishes a new version
- **THEN** the pack stays private and remains absent from the public listing

#### Scenario: Baseline sweep

- **WHEN** the hygiene baseline is checked against the catalog after the sweep task
- **THEN** no acceptance/demo pack is publicly listed and every public pack carries a category

### Requirement: 发布门校验多语言叠加块

发布门与 dry-run 校验 SHALL 对 manifest 顶层 `i18n` 块(形状见 pack-locale-tracks)执行以下规则,违者以**逐字段点名**的结构化错误拒绝(沿既有 `entry` 风格,形如 `i18n.en.guide.steps[1].title`):每个覆盖值 SHALL 为非空字符串且遵守与对应基字段相同的长度帽;`guide.steps` 在同一 locale 下 SHALL 要么三步 title 与 body 全部覆盖、要么整组缺省,半步散件 SHALL 被拒;数组索引越界与未声明的命名实体引用 SHALL 被拒;locale 键形非法或为 `zh` SHALL 被拒。**BREAKING 说明**:本规则只新增可选块的校验——不含 `i18n` 的既有 manifest 行为不变。

#### Scenario: 结构一致性断裂被拒

- **WHEN** `i18n.en` 覆盖 guide 三步中的两步或只覆盖某步的 title 未覆盖 body
- **THEN** 发布门拒绝,报错指名为 `i18n.en.guide` 的结构不完整

#### Scenario: 逐 locale 长度帽parity

- **WHEN** `i18n.en.description` 超过 description 的长度上限
- **THEN** 发布门拒绝并点名 `i18n.en.description`,错误文案与基字段帽同款

#### Scenario: dry-run 与正式发布同规则

- **WHEN** 同一份含非法 `i18n` 块的 manifest 分别提交 dry-run 校验端点与发布端点
- **THEN** 两处返回完全相同的逐字段点名错误清单,且不存储任何版本

### Requirement: 长度比率与 en 副轨禁辞扫描

对长文覆盖字段(description 与 guide.steps[].body),发布门 SHALL 强制每 locale 覆盖文本与 zh 基字段的字符长度比率不超过 3:1(双向:`|loc| / |zh|` 与 `|zh| / |loc|` 均 ≤3),越界以可读报错拒绝(比率门槛仅拦截语种错位/内容贴错,正常翻译膨胀不受影响);比率 SHALL 设有最小长度地板,任一侧短于该地板即不施比率(极短字段的合法译长不构成信号)。发布门 SHALL 对 `i18n` 块内全部英文字符串执行与营销物料审计同款(ABSOLUTE_CLAIM_RE 同规则)的绝对化表述扫描,违例逐字段点名拒绝。zh 基字段本版本不施该扫描。

#### Scenario: 长度比率越界被拒

- **WHEN** zh 基 description 为 40 字,`i18n.en.description` 为 200 字符(比率 5:1)
- **THEN** 发布门拒绝并报该字段比率越界

#### Scenario: en 绝对化表述被拦

- **WHEN** `i18n.en` 任一字符串命中绝对化宣称禁辞(如 "fully replace your team")
- **THEN** 发布门拒绝并点名该 locale 字段路径

#### Scenario: 短字段豁免比率

- **WHEN** zh 基的 `i18n.en` name 覆盖为短字段且比率超过 3:1
- **THEN** 不触发比率错误(短字段不在比率门槛内),仅长度帽生效

### Requirement: 市场浏览与详情按 locale 解析

市场列表摘要与详情响应 SHALL 按 pack-locale-tracks 的解析优先级与回落规则呈现显示字段:name、description、tags(tag 检索语义不变)、guide 及详情内卡片文本按请求 locale 投影;列表行的冗余索引列(name/description/tags)SHALL 继续存 zh 主轨文本,搜索(`search`/`tag` 参数)行为与变更前一致(zh 检索);按非 zh locale 读取列表时 name/description 呈现叠加块覆盖值,搜索范围不变。

#### Scenario: 双语条目列表行按 locale 呈现

- **WHEN** 市场列表请求携带 `locale=en`,某条目含 `i18n.en.name`/`i18n.en.description`
- **THEN** 该条目摘要行呈现英文覆盖值;不含覆盖的条目呈现中文

#### Scenario: 搜索保持 zh 语义

- **WHEN** 以 `locale=en` 且 `search=<英文关键词>` 请求市场列表
- **THEN** 检索仍在 zh 冗余列上进行,行为与无 locale 参数时一致(本版本不提供多语检索)

#### Scenario: 无 locale 请求响应字节等价

- **WHEN** 旧客户端(不传 locale、无 Accept-Language)请求列表与详情
- **THEN** 响应显示字段与本次变更前逐字节等价

### Requirement: Market entries carry a structure-derived type badge

Every market entry SHALL display exactly one type badge derived automatically from the manifest structure, in this precedence order:

- **蓝图 (Blueprint)** — the manifest declares a fleet/cluster organization block
- **分身 (Facade)** — no organization block, but at least one agent in the pack carries a facade serving contract
- **助手 (Assistant)** — the pack declares agents but neither an organization block nor a facade serving contract
- **工具 (Toolkit)** — the pack declares no agents (pure skills/MCP bundle)

The badge SHALL be computed by the platform — authors MUST NOT be able to set or override it via manifest fields or display-name conventions. It SHALL be visible on store listing cards and on the pack detail view, with en labels (Blueprint / Facade / Assistant / Toolkit) on the en surface.

#### Scenario: Fleet-template pack earns Blueprint badge

- **WHEN** a published pack's manifest declares a fleet/cluster organization block
- **THEN** its store card and detail view display the 蓝图 / Blueprint badge

#### Scenario: Facade pack earns Facade badge

- **WHEN** a published pack declares no organization block but includes an agent with a facade serving contract
- **THEN** its badge is 分身 / Facade

#### Scenario: Agent pack without organization or facade earns Assistant badge

- **WHEN** a published pack declares agents but no organization block and no facade serving contract
- **THEN** its badge is 助手 / Assistant

#### Scenario: Pure tool bundle earns Toolkit badge

- **WHEN** a published pack declares only skills and/or MCP references and no agents
- **THEN** its badge is 工具 / Toolkit

#### Scenario: Existing entries gain badges without republish

- **WHEN** the badge derivation ships
- **THEN** already-published entries (e.g. CRM 客服套件 → 工具, 分身工坊 → 助手, 寻数分身 → 分身) display correct badges with no republish required, since derivation is structural and applies at read time

### Requirement: 付费条目呈现与购买动作

市场列表与详情视图 SHALL 如实呈现条目的价格与计费形态（一次性买断/订阅期），免费条目不渲染价格区。详情视图 SHALL 对已登录买家提供购买动作入口；购买完成前安装付费条目 SHALL 以「未成交」分类如实拒绝并指引购买，免费条目安装行为不变。购买动作 SHALL 只对已登录用户可用，匿名访问保持只读。

#### Scenario: 付费条目价格可见

- **WHEN** 用户打开一个声明价格的条目详情
- **THEN** 价格与计费形态随详情一并呈现，值与版本级价格声明一致

#### Scenario: 未成交安装被如实挡

- **WHEN** 用户安装一个自己未成交的付费条目
- **THEN** 安装以未成交分类拒绝并指引购买路径，不物化任何内容

#### Scenario: 免费条目安装不变

- **WHEN** 用户安装一个免费条目
- **THEN** 行为与引入付费能力之前完全一致

### Requirement: 市场条目承载供应商署名

发布者 SHALL 可在发布时声明包归属于其绑定的某个供应商主体；网关 SHALL 校验该绑定真实存在后，把供应商主体署名（公开署名字段）投影进市场条目与详情视图——署名来自服务端档案，manifest 文本与包内容 SHALL NOT 承载可自行编写的署名声明。未声明归属的条目不署供应商名（仅作者身份呈现），未绑定主体的发布者提供归属声明 SHALL 以资格分类如实拒绝。供应商主体的公开署名变更 SHALL 使条目呈现随之更新（呈现时取当前档案值），已发布版本的历史归档不变更。

#### Scenario: 归属声明进条目

- **WHEN** 绑定供应商甲的发布者发布 pack 并声明归属甲
- **THEN** 市场列表与详情视图对该条目呈现甲的公开署名，署名值取自供应商档案而非 manifest

#### Scenario: 无权署名如实拒

- **WHEN** 发布者声明的供应商主体并非其绑定主体
- **THEN** 发布以资格分类拒绝并说明绑定关系不成立，不产生条目

#### Scenario: 无归属声明不署名

- **WHEN** 未声明归属的发布（内部作者或不带归属的 vendor 发布）上架
- **THEN** 条目仅呈现既有作者身份，不虚构供应商署名

### Requirement: 订阅跟新提示

一条目发布新版本后，该条目的订阅者 SHALL 收到账内跟新提示（版本号与变更摘要，经既有账内 unread 提示通道送达）；提示为纯通知，SHALL NOT 触发任何形式的自动升级、自动重装或已装内容变更。订阅者可在市场面与管理面看到「有新版」状态并显式选择升级（既有显式更新语义不变）。提示对免费与付费条目同轨；付费条目的新版本可见性遵循其成交范围语义。

#### Scenario: 发新版得提示

- **WHEN** 已订阅条目发布新版本
- **THEN** 订阅者账内出现跟新提示，订阅条目呈现有新版状态，已装内容原样不动

#### Scenario: 提示不升任何装

- **WHEN** 订阅者未做任何显式升级动作
- **THEN** 其已装快照与订阅关系逐字节不变，仅提示与状态标记存在

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

### Requirement: CodeBuddy-compatible marketplace repository

The facet service SHALL be able to project its listed packs into a marketplace repository in the CodeBuddy/WorkBuddy plugin-marketplace format — a repository root carrying `.codebuddy-plugin/marketplace.json` and, per listed pack, a plugin directory containing the pack's skills as skill directories (each with a `SKILL.md` and any auxiliary files) and its agents as plugin agents. The repository SHALL be the distribution form for clients that cannot recursively fetch plugin files over HTTP; it SHALL NOT replace or alter the existing Claude-format endpoint.

Listing admission SHALL be the same single source the browse face and the Claude endpoint consume — public, non-unlisted, and curated (`category` non-empty or `featured` true), unless the operator whitelist (`FACET_MARKETPLACE_PACK_IDS`) is set, in which case the whitelist alone defines the listing (override semantics). Private and unlisted packs SHALL be absent from the repository, and no pack that the browse face hides SHALL appear.

MCP references SHALL appear in the plugin body as connection guidance (endpoint and credential notice) only, and SHALL NOT be embedded as server configuration. Each marketplace entry SHALL carry the pack's current published version, so a client's version-pinned install stays reproducible.

Snapshot generation SHALL be self-validating: the produced manifest SHALL parse, every entry SHALL resolve to a present directory, and no file path SHALL escape its plugin directory. A snapshot that fails validation SHALL NOT be published, and the previously published snapshot SHALL remain intact (last-good).

The repository SHALL reflect publish, unpublish, and curation changes within one refresh cycle, and that refresh bound SHALL be stated in the channel's operator documentation.

#### Scenario: Curated pack installs from the repository

- **WHEN** a client adds the marketplace repository by its Git address and installs a listed plugin
- **THEN** the plugin's skills and agents are materialized from the repository's own files, with no further network fetch of plugin content
- **AND** the installed version equals the version the marketplace manifest declares

#### Scenario: Non-public packs never reach the repository

- **WHEN** a pack is private or unlisted
- **THEN** it is absent from the generated manifest and its plugin directory is absent from the repository

#### Scenario: Curation drives admission, whitelist overrides

- **WHEN** a public non-unlisted pack has an empty `category` and a false `featured` flag, and no operator whitelist is set
- **THEN** the pack is absent from the generated manifest
- **AND** when `FACET_MARKETPLACE_PACK_IDS` lists that pack id, the pack is present

#### Scenario: MCP stays guidance in the repository too

- **WHEN** a listed pack declares MCP server references
- **THEN** the plugin's guidance text names each endpoint and the credential requirement
- **AND** the plugin's manifest and files contain no MCP server configuration and no credential material

#### Scenario: Failed snapshot keeps the last good one

- **WHEN** snapshot generation produces a manifest that fails validation (unparseable, missing entry directory, or an escaping path)
- **THEN** nothing is published and the previously published snapshot remains the one clients see
- **AND** the failure is reported as a failure, not as a successful refresh

#### Scenario: Path escape is refused

- **WHEN** a pack's file list contains an absolute path, a `..` segment, a drive letter, or a NUL byte
- **THEN** the snapshot is rejected rather than sanitized silently

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

### Requirement: 界面语言变化后市场读面重新取数

市场列表与详情 SHALL 在界面语言变化后自动以新 locale 重新请求;重新请求 SHALL 是静默刷新(保留已渲染内容直到新数据到达,SHALL NOT 清空为骨架)。请求失败时 SHALL 保留旧数据并给出一条非阻断提示,SHALL NOT 静默吞掉错误。详情视图 SHALL 在语言变化后重取当前正在查看的条目,SHALL NOT 要求用户关闭再打开。

#### Scenario: 切语言后卡片随语言变

- **WHEN** 访客在英文界面已加载市场列表,随后把界面语言切到中文
- **THEN** 列表在不经任何手动搜索或刷新的情况下,呈现中文的名称、描述与标签

#### Scenario: 切语言后打开的详情随语言变

- **WHEN** 访客打开某条目的详情后切换界面语言
- **THEN** 该详情在不关闭的情况下重取并呈现新语言的显示字段

#### Scenario: 重取期间不闪白

- **WHEN** 语言切换触发的重取正在进行
- **THEN** 已渲染的卡片保持可见,不出现整列表骨架或空白

#### Scenario: 重取失败保留旧数据

- **WHEN** 语言切换触发的重取请求失败
- **THEN** 列表保持切换前的数据可见,并出现一条可读的非阻断提示说明内容仍是旧语言

### Requirement: 市场卡片按五槽位呈现

市场列表的每个条目 SHALL 按五个固定槽位呈现:身份(印章标识、名称、结构徽章、来源徽章、版本)、一句话承诺、可得信号(技能数、角色数、工具面数)、适用人群、边界行。未知的可得信号计数 SHALL 省略该段而不是显示 0。卡片 SHALL 是单一可点区域,SHALL NOT 在可点区域内嵌套第二个独立可点目标。

#### Scenario: 长描述不再撑爆卡片

- **WHEN** 一个条目的 description 长度超过 400 字
- **THEN** 卡片只呈现降级链推出的承诺文本,SHALL NOT 出现被裁半行的长段落

#### Scenario: 可得信号来自结构

- **WHEN** 一个条目声明 4 条技能、1 个角色、3 个 MCP 引用
- **THEN** 卡片显示技能 4、角色 1、工具面 3 三项信号

#### Scenario: 未知计数省略而非归零

- **WHEN** 服务端未投影某条目的角色数(老版本响应)
- **THEN** 卡片省略角色数那一段,不显示 0,也不显示占位符

#### Scenario: 卡片无嵌套点击目标

- **WHEN** 用户用键盘在卡片内按 Tab
- **THEN** 焦点不进入卡片内部,整张卡片只有一个可点区域与一个焦点停靠点

### Requirement: 详情按七段式信息架构呈现

详情视图 SHALL 按固定顺序呈现七个段落:首屏承诺与主动作、你会得到、三步上手、示例指令、角色/技能/工具面、边界与诚实声明、版本时间线与安装动作。缺数据的段落 SHALL 整段省略,SHALL NOT 渲染空段或占位文案。示例指令的每一条 SHALL 可直接带着其 `prompt` 进入对话或复制,SHALL NOT 只是展示文本。

#### Scenario: 有示例的条目可一键带走

- **WHEN** 用户打开一个声明了 `examples` 的条目详情并激活某条示例
- **THEN** 该示例的 `prompt` 被完整带入对话输入处或复制到剪贴板,文本逐字一致

#### Scenario: 缺示例的条目整段省略

- **WHEN** 一个条目没有 `examples`
- **THEN** 详情不出现"示例指令"段,也不出现任何"暂无示例"占位

#### Scenario: 边界与诚实声明有固定位置

- **WHEN** 一个条目的 `notes` 声明了使用边界
- **THEN** 该文本出现在详情第六段,位置在技能正文之前

#### Scenario: 技能正文仍可全量检视

- **WHEN** 用户打开任意条目的详情
- **THEN** 每条技能的正文仍然可查看(既有的"订阅前可检视"契约不因分段重排而回退)

### Requirement: 搜索跨越语言轨道

市场搜索 SHALL 在请求的 locale 下同时匹配 zh 主轨与当前 locale 的覆盖文本。`locale=zh` 的搜索 SHALL 保持与变更前等价的匹配语义。

#### Scenario: 英文关键词命中英文名

- **WHEN** 以 `locale=en` 搜索一个只在 `i18n.en.name` 中出现、`zh` 主轨中不出现的英文关键词
- **THEN** 该条目出现在结果中

#### Scenario: 中文关键词在 zh 下仍命中

- **WHEN** 以 `locale=zh` 搜索一个中文关键词
- **THEN** 匹配结果与变更前等价

#### Scenario: 非匹配关键词返回空

- **WHEN** 以 `locale=en` 搜索一个在任何轨道中都不存在的关键词
- **THEN** 返回空结果而不是全量列表

### Requirement: 分面集合来自声明体系

市场分面 SHALL 由分类体系的声明目录驱动并携带每个取值的在架计数,SHALL NOT 由当前返回页面里出现过的字符串集合驱动。线轴 SHALL 恒呈现声明的全部取值(计数为 0 也呈现,以零计数样式呈现并给出该线暂无内容的可读提示);领域轴 SHALL 只呈现计数大于 0 的取值。分面顺序 SHALL 是声明顺序,SHALL NOT 随语言切换或内容进出而变化。

#### Scenario: 内容增减不改分面形状

- **WHEN** 某个线下的最后一条内容被下架
- **THEN** 该线的 chip 仍然存在且计数为 0,其余 chip 的位置不变

#### Scenario: 分面顺序不随语言变

- **WHEN** 同一访客先把界面语言设为中文再切到英文
- **THEN** 分面 chip 的数量与顺序完全一致,只有标签文本改变

#### Scenario: 零计数线可读提示

- **WHEN** 用户点击一个计数为 0 的线 chip
- **THEN** 列表呈现该线暂无上架内容的可读提示,而不是空白或错误

### Requirement: 官方徽章按来源收敛

列表与详情的来源徽章 SHALL 只由服务端的来源判定投影决定,SHALL NOT 因条目数量占多数而失去区分度:官方徽章 SHALL 只出现在被来源判定为官方的条目上,官方精选·已审校 SHALL 只出现在同时满足官方与已审校的条目上,其余条目 SHALL NOT 显示两者中的任何一个。

#### Scenario: 社区条目不显示官方徽章

- **WHEN** 一个非官方作者的公开条目出现在列表中
- **THEN** 该条目不带官方徽章,也不带官方精选徽章

#### Scenario: 官方条目的两种徽章互斥呈现

- **WHEN** 一个官方条目没有已审校记录
- **THEN** 它显示官方徽章,不显示官方精选徽章

### Requirement: 市场面只在网关前置部署出现

市场界面（浏览、详情、订阅、我的包、创作/发布）SHALL 只在部署报告 `packMarketplace` 为真的形态下可达；`/api/config` 报告 `packMarketplace: false` 时，判据 SHALL 作用在智能体市场面（`/agents`）的 `market` tab 上，而不是整页：该 tab SHALL 缺席，`mine` tab SHALL 照常渲染（已装快照与创作草稿都是本地状态），市场面 SHALL NOT 以空壳形式留在原地。`/packs` 及其深链（`?tab=`、`?deployCastPack=`）SHALL 重定向到 `/agents` 的对应 tab，并保留这两类参数（分面工坊的部署交接 `deployCastPack=` 是契约，不得被静默丢弃）；市场 tab 因判据缺席时，重定向 SHALL 落到该面的首个可见 tab（`mine`），既有链接 SHALL NOT 以死链收场。

判据 SHALL 在市场面自己的路由/页面里执行，而不是依赖某个上层容器是否挂载它——挂载点
会随信息架构搬迁（agents 中心页已于 2026-11-06 拆解，`/packs` 于 2026-11-07 以独立
路由恢复，2026-11-08 又并回 `/agents` 的 `market` tab），而这条边界不该随挂载点搬家丢失。
判据所用的配置 SHALL 在首绘前已就绪，避免首次渲染时把网关前置部署误判为本地部署。

非市场面不受此限：已装包管理与创作草稿（更新/卸载、草稿/发布入口）属于本地状态与运行域，
两个部署形态都 SHALL 保留，因此 `mine` tab 在两种形态下都 SHALL 可渲染。

#### Scenario: 本地部署访问市场深链

- **WHEN** `/api/config` 报告 `packMarketplace: false`，用户访问 `/packs?tab=market`
- **THEN** 应用重定向到 `/agents` 并激活首个可见 tab（`mine`）
- **AND** 市场面（`packs-page`、市场页签、市场卡片）不出现
- **AND** 已装快照与创作草稿仍可在此面管理，链接不以死链收场

#### Scenario: 网关前置部署行为不变

- **WHEN** `/api/config` 报告 `packMarketplace: true`，用户访问 `/packs`
- **THEN** 重定向到 `/agents?tab=market`，市场面正常渲染，页签与市场列表可用

#### Scenario: 部署交接参数随重定向保留

- **WHEN** `/api/config` 报告 `packMarketplace: true`，用户访问 `/packs?deployCastPack=<packId>`
- **THEN** 重定向后的地址仍携带 `deployCastPack=<packId>`，分面工坊的部署交接照旧完成
