# agent-catalog Specification

## Purpose
Defines how the platform serves its agent and app catalog — merging local `agents.json`, the cloud `AGENTS_CONFIG_URL` document, and registry agent entries into one role-filtered, secret-redacted entry list — and how selection works across the Agents & Apps page and the chat control strip: the built-in local runtime, remote `chat` entries served locally through generated persona presets (remote fork only as a fallback), `link` entries, and bound `app` entries via the Nango connect broker.

## Requirements

### Requirement: Catalog entry types

The catalog SHALL accept entries of three types: `agent-local` (the built-in agent session, now backed by the dsh runtime instead of the pi session), `agent-remote` (an external agent reached over an OpenAI-compatible HTTP API or the A2A protocol, with `mode` either `chat`, `link`, or `a2a`), and `app` (a third-party bound application, with `kind` either `link` or `nango-connect`). Every entry SHALL have a unique `id`, MAY declare `roles` (a list of group names restricting visibility) and a display `name`. An `a2a`-mode entry SHALL carry the A2A route `url` of a registry gateway-proxied Agent Service. A chat-mode `agent-remote` entry sourced from an installed pack that declares `cluster` metadata SHALL additionally carry `clusterId` (the source pack id), `clusterName`, and `isDefaultAgent`, on both `GET /api/catalog` and the `agents` WebSocket message (openspec: agent-cluster-core); entries from other sources carry none of them.

#### Scenario: Built-in agent is always present

- **WHEN** the catalog is served
- **THEN** the built-in `agent-local` entry represents the dsh-backed agent session, and selecting it behaves exactly as before this change (prompts route to the dsh runtime via the bridge)

#### Scenario: Invalid entries are skipped

- **WHEN** a catalog source contains an entry with an unknown `type`, a duplicate `id`, a `chat`-mode `agent-remote` missing `baseUrl` or `model`, or an `a2a`-mode `agent-remote` missing `url`
- **THEN** the server logs a warning, drops that entry, and serves the rest of the catalog

#### Scenario: Cluster pack members carry cluster fields

- **WHEN** a pack with cluster metadata is installed and the catalog is served
- **THEN** its member entries carry `clusterId`, `clusterName`, and `isDefaultAgent`, while built-in and registry entries do not

### Requirement: Dual-source configuration with cloud precedence

The catalog SHALL merge five optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored), a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays), agent entries from the configured mcp-gateway-registry (`GET /api/agents`, using the market registry env vars), agent entries from packs installed in the cell (openspec: pack-installation), and agent entries from the cell's user-defined presets (openspec: custom-presets). Registry agent entries SHALL be adapted to `agent-remote` entries in `link` mode (external URL) unless the registry entry declares an OpenAI-compatible endpoint, in which case `chat` mode applies with `baseUrl` and `model` mapped and the key resolved from an env var reference; a registry entry whose `supported_protocol` is `a2a` SHALL instead map to an `a2a`-mode entry whose `url` is the gateway route (`{registry}/agent/{path}/`), regardless of any external URL it carries. Registry group membership SHALL map to the catalog entry's `roles` (no groups ⇒ visible to everyone). Pack-sourced entries SHALL be `agent-remote` `chat` entries carrying the pack's display fields and persona, with no endpoint or credential fields, and follow the same local persona-preset serving as other `chat` entries; the client-facing payload for pack-sourced entries SHALL additionally carry their `packId`, so picker surfaces can role-mark them (openspec: pack-agent-scoping). Custom-preset entries SHALL be persona-only `chat` entries carrying their display fields and a `customPreset` marker with a resource summary, following the same local persona-preset serving and focus marking. On `id` collision the later source SHALL win, in the order built-in → registry → packs → user presets → `agents.json` → cloud: local overrides remote, and the cloud remains the live control plane even for ids first defined elsewhere. When the registry or cloud fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning; pack-sourced and custom-preset entries are local state and need no fetch.

**The registry agents leg is source-independent**: even when the market catalog's mcp/skills species are served by the unified facet catalog projection (a facet catalog URL configured), the registry agents leg SHALL still be read from the registry agents API (same market registry env vars), so `a2a`-mode entries remain available for fleet posts, room summoning, and picker surfaces. The agents leg SHALL degrade independently of the facet projection: an agents fetch failure SHALL keep last-good agents and warn without failing the mcp/skills refresh, and vice versa.

#### Scenario: Cloud entry overrides local

- **WHEN** `agents.json` defines an entry with id `junior` and the cloud document defines the same id
- **THEN** the merged catalog contains the cloud version of `junior`

#### Scenario: Cloud outage does not clear the catalog

- **WHEN** `AGENTS_CONFIG_URL` becomes unreachable after a successful fetch
- **THEN** the catalog keeps the last good cloud entries and the server logs a warning instead of dropping them

#### Scenario: Registry entry is shadowed by any local definition

- **WHEN** the registry defines an agent with id `junior` and `agents.json` also defines `junior`
- **THEN** the merged catalog contains the `agents.json` version of `junior`
- **AND** a cloud entry with the same id still wins over both

#### Scenario: Registry groups gate visibility

- **WHEN** a registry agent belongs to registry group `team-a` and the requesting user's groups do not include `team-a`
- **THEN** the entry SHALL be mapped with `roles: ["team-a"]` and SHALL NOT appear in that user's `GET /api/catalog`

#### Scenario: Registry outage does not clear the catalog

- **WHEN** the registry becomes unreachable after a successful refresh
- **THEN** the catalog keeps the last-good registry entries and the server logs a warning instead of dropping them

#### Scenario: A2A registry agents map to a2a mode

- **WHEN** the registry lists an enabled agent with `supported_protocol: "a2a"`
- **THEN** the catalog contains an `a2a`-mode entry whose `url` is the gateway route `{registry}/agent/{path}/` (`{registry}` being the registry gateway base URL, not a hard-coded example domain), and no `link` entry is created for it

#### Scenario: Deployed role coexists with its in-cell persona

- **WHEN** a pack's role is deployed as an Agent Service and a user has also installed that pack in their cell
- **THEN** both entries appear independently — the registry-sourced `a2a` entry and the pack-sourced `chat` persona — without id collision or shadowing

#### Scenario: Pack agent appears after subscribe

- **WHEN** a user subscribes to a pack containing an agent entry and the catalog is next served
- **THEN** the pack's agent appears in `GET /api/catalog` (carrying its `packId`) and in the agent picker, running as a local persona when selected

#### Scenario: Pack agent is shadowed by the cloud and local file

- **WHEN** a subscribed pack defines an agent with id `junior` and the cloud document (or `agents.json`) also defines `junior`
- **THEN** the merged catalog contains the cloud (or local file) version of `junior`

#### Scenario: Pack agent wins over a registry entry with the same id

- **WHEN** a subscribed pack defines an agent with id `junior` and the registry also lists an agent with id `junior`
- **THEN** the merged catalog contains the pack version of `junior`

#### Scenario: Unsubscribing removes the pack entry

- **WHEN** a user unsubscribes from a pack whose agent was in the catalog
- **THEN** the pack's agent disappears from `GET /api/catalog` and the picker, and other sources' entries with other ids are unaffected

#### Scenario: Custom preset appears after creation

- **WHEN** a user creates a custom preset and the catalog is next served
- **THEN** the entry appears in `GET /api/catalog` carrying its `customPreset` marker and resource summary, badged as a focused role in the picker

#### Scenario: Custom preset is shadowed by operator and cloud sources

- **WHEN** a custom preset has id `user.junior` and `agents.json` (or the cloud document) defines an entry with the same id
- **THEN** the merged catalog contains the `agents.json` (or cloud) version, and the preset id composes full mode under the overriding entry's persona — the same shadowing semantics pack agents follow

#### Scenario: Deleting removes the custom entry

- **WHEN** a user deletes a custom preset
- **THEN** its entry disappears from `GET /api/catalog` and the picker, and its generated preset is pruned

#### Scenario: Facet-served market still carries registry agents

- **WHEN** the deployment configures a facet catalog URL (the mcp/skills species come from the facet projection) and the registry lists enabled `a2a` agents
- **THEN** the merged catalog contains those agents as `a2a`-mode entries with gateway-route urls, and fleet posts targeting them resolve alive rather than vacant

#### Scenario: Agents leg degrades independently of the facet projection

- **WHEN** the facet projection refresh succeeds but the registry agents fetch fails (unreachable or unauthorized)
- **THEN** the mcp/skills species still refresh, the catalog keeps last-good agents, and the server logs a warning — neither face is blocked by the other's failure

### Requirement: A2A agents chat over the A2A protocol

While the active agent is an `a2a`-mode `agent-remote` entry, a `prompt` SHALL be served by the remote branch: the platform SHALL act as an A2A client, forwarding the turn to the entry's route via `message/send` (or `message/stream` when the card advertises streaming), mapping streamed parts to the existing `text` events, completion to `done`, and failures to `error`. Selecting or leaving an `a2a` entry SHALL NOT switch presets or restart the shared dsh runtime, and turn history SHALL persist in the cell session as with other remote turns.

#### Scenario: Chatting with a deployed Agent Service

- **WHEN** the user selects an `a2a`-mode entry and sends a prompt
- **THEN** the reply streams into the chat UI through the existing `text` events and finishes with `done`, with no shared-runtime restart

#### Scenario: Follow-up keeps context

- **WHEN** the user sends a second prompt in the same session with an `a2a` entry active
- **THEN** the forwarded turn carries the prior conversation so the Agent Service can follow up

#### Scenario: Remote failure surfaces as error

- **WHEN** the Agent Service's route returns an error or the stream aborts mid-flight
- **THEN** the client receives an `error` event and the server returns to the non-streaming state

#### Scenario: Switching away does not touch the runtime

- **WHEN** the user switches from an `a2a` entry back to the built-in agent
- **THEN** no preset switch or runtime restart occurs for the shared dsh runtime

### Requirement: Periodic refresh with live propagation
The server SHALL re-fetch the cloud document AND the registry agents every `CATALOG_REFRESH_SECS` seconds (default 60) and on `POST /api/catalog/refresh`. When the merged catalog changes, the server SHALL broadcast a `catalog_changed` event over WebSocket; clients react by refetching `GET /api/catalog`.

#### Scenario: Cloud edit reaches connected clients
- **WHEN** an entry is added to the cloud document and the next refresh runs
- **THEN** all connected WebSocket clients receive `catalog_changed` and a subsequent `GET /api/catalog` includes the new entry

#### Scenario: Registry agent reaches connected clients
- **WHEN** an agent is registered in the registry and the next refresh runs
- **THEN** all connected WebSocket clients receive `catalog_changed` and a subsequent `GET /api/catalog` includes the new entry for users whose groups permit it

#### Scenario: Manual refresh
- **WHEN** `POST /api/catalog/refresh` is called by a user whose groups include `admin` (by any client when auth is off)
- **THEN** the cloud document and registry agents are re-fetched immediately and the response returns the refreshed, redacted catalog

### Requirement: Role-based visibility

An entry with a non-empty `roles` array SHALL be included in `GET /api/catalog` only when the requesting user's groups intersect the entry's `roles`. Entries with empty or absent `roles` SHALL be visible to everyone. When authentication is off, the requester is the machine owner and all entries SHALL be visible — matching the auth-off owner semantics of administrator gating and market visibility filtering (a deployment with no identities has no one to exclude).

#### Scenario: Role-gated entry hidden from plain users

- **WHEN** a user with groups `["dev"]` requests the catalog and an entry declares `roles: ["admin"]`
- **THEN** that entry is absent from the response

#### Scenario: Auth-off requester sees role-gated entries

- **WHEN** authentication is off and the catalog contains entries declaring `roles`
- **THEN** those entries are present in the response, because the requester is the machine owner

### Requirement: Secret redaction

Client-facing catalog payloads SHALL NOT include API keys or tokens. Remote-agent entries reference secrets by `apiKeyEnv` (a server environment variable name) resolved server-side at call time; a literal `apiKey` in a source document, if used, SHALL be stripped from every client response along with the Nango secret.

#### Scenario: Catalog response carries no secrets

- **WHEN** any client calls `GET /api/catalog`
- **THEN** no entry in the response contains `apiKey`, a resolved key value, or `NANGO_SECRET_KEY`

### Requirement: Agent selection and remote chat streaming

The WebSocket protocol SHALL gain `set_agent` (client→server) and `agents` / `current_agent` / `agent_changed` (server→client), mirroring the model-selection messages.

While the active agent is a `chat`-mode `agent-remote`, the turn SHALL be served by the LOCAL runtime when the deployment has generated a persona preset for that entry (see the new requirement below) — the entry's identity becomes the session's persona and the turn keeps the local runtime's tools (MCP servers, skills) and session history. Only when no persona preset exists for the entry SHALL a `prompt` be forwarded to the entry's OpenAI-compatible `/chat/completions` endpoint with `stream: true`; that fork SHALL replay the session's mirrored turns (most recent first up to a bounded count) plus a system message naming the entry, so a remote turn is not a standalone question. In both cases SSE deltas are re-broadcast as the existing `text` events, completion as `done`, and failures as `error`. Agent switching SHALL be rejected while a prompt is streaming.

#### Scenario: Chatting with a locally-served agent

- **WHEN** the user selects a `chat`-mode remote agent the deployment serves locally and sends two prompts in one session
- **THEN** both turns run on the local runtime — the second sees the first, and tools the deployment composed (MCP servers, skills) are available — with the entry's name/description as the persona

#### Scenario: Chatting with a remote agent

- **WHEN** no persona preset exists for the selected entry and the user sends a prompt
- **THEN** streamed completions render in the chat UI through the existing `text` events and finish with `done`, with no frontend changes beyond agent selection

#### Scenario: Forked remote agent keeps the conversation

- **WHEN** the user sends a second prompt to a forked remote agent in the same session
- **THEN** the request carries the session's prior turns (bounded) so the entry can follow up on what it already said

#### Scenario: Remote failure surfaces as error

- **WHEN** the remote endpoint returns an error or the stream aborts mid-flight
- **THEN** the client receives an `error` event and the server returns to the non-streaming state

#### Scenario: Switch blocked mid-stream

- **WHEN** a `set_agent` message arrives while a prompt is streaming
- **THEN** the switch is rejected, mirroring `set_model` behavior

### Requirement: Catalog chat agents are served with local persona presets

Every `chat`-mode `agent-remote` catalog entry SHALL be served by the local runtime through a generated agent preset: the deployment SHALL compose one preset per entry from the shipped `standard` agent-plane composition, replacing only the persona row's text with a persona derived from the entry (its `persona` field when present, else its `name`/`description`/`tags`), and SHALL write it into the preset roster's user root so the existing roster/picker/switch machinery applies it. For pack-sourced and custom-preset entries the derived persona SHALL append a focus note stating that the role's tools and skills focus on its own resource set (openspec: pack-agent-scoping, custom-presets), so the role answers requests outside its resource set honestly instead of inventing results. Generated presets SHALL carry a marker file so hand-authored user presets are never overwritten or pruned, SHALL be pruned when their entry leaves the catalog, SHALL NOT shadow a shipped preset id, and SHALL be regenerated (with an idle-runtime restart) whenever the merged catalog changes. An entry MAY declare `local: false` to stay a remote service instead: it gets no preset and its turns fork as before. The persisted agent-preset preference SHALL be validated against the presets the deployment can actually mount before the runtime spawns, falling back to the deployment default so a stale id can never fail session creation.

#### Scenario: A pack agent keeps the platform's capabilities

- **WHEN** the user selects a vertical-pack agent and asks a question in its domain
- **THEN** the turn runs on the local runtime with the pack's persona and the pack's skills and MCP tools plus the deployment baseline available (openspec: pack-agent-scoping), with the session's prior turns in context

#### Scenario: Selecting the agent is a preset switch

- **WHEN** the user selects a locally-served catalog agent while the runtime is idle
- **THEN** the runtime restarts with that preset (the same path as a model or preset switch), `agent_changed` lands after the switch, and the session header names the agent; a switch requested while a turn streams is rejected

#### Scenario: Switching back to the built-in agent

- **WHEN** the user selects the built-in `local` agent
- **THEN** the deployment's own persisted preset is restored, dropping the pack persona and its focused resource set

#### Scenario: Departed entry leaves no broken selection

- **WHEN** a catalog entry that had a generated preset disappears from the catalog
- **THEN** its preset directory is pruned, the selection falls back to the built-in agent, and clients are told through `agent_changed`

### Requirement: Link agents

A `link`-mode `agent-remote` entry carries a `url`; the Agents page SHALL present it as an external link, and PAAS SHALL NOT proxy or embed it.

#### Scenario: Link agent on the page

- **WHEN** the catalog contains a `link`-mode remote agent
- **THEN** the Agents & Apps page shows it as a link that opens its `url` in a new tab

### Requirement: App entries and the Nango connect broker

`app` entries of `kind: "link"` carry a `url` opened externally. Entries of `kind: "nango-connect"` declare `nangoUrl`, `connectUiUrl`, and `apiUrl`; `POST /api/apps/:id/connect` SHALL mint a Nango connect session server-side using the server-held `NANGO_SECRET_KEY` (POST `<nangoUrl>/connect/sessions` with tags `end_user_id` / `end_user_email` / `organization_id` derived from the requesting user's email) and return the Connect UI URL with `session_token` and `apiURL` query params. The endpoint SHALL return an error when authentication is off, since there is no identity to tag.

#### Scenario: Bound-app connect flow

- **WHEN** an authenticated user triggers connect on a `nango-connect` entry
- **THEN** they are redirected to the Connect UI with a freshly minted session token whose tags carry their email, and the Nango secret never appears in any client-visible payload

#### Scenario: Broker unavailable without auth

- **WHEN** `AUTH_MODE` is off and `POST /api/apps/:id/connect` is called
- **THEN** the server responds with an error explaining the flow requires login

### Requirement: v1 shared-session ceiling

In v1 the local agent remains one shared session for all clients — now a single shared dsh runtime subprocess, not a per-connection or per-user dsh session. Remote-agent chats are broadcast to all connected clients and are not persisted into chat-history, and there is no per-user isolation of sessions or documents. This ceiling SHALL be documented rather than silently discovered.

#### Scenario: Remote chat visibility

- **WHEN** two clients are connected and one chats with a remote agent
- **THEN** both clients see the streamed `text` events, consistent with the existing shared-session broadcast model

### Requirement: Agents & Apps page is a top-level route with sub-tabs

The `/agents` route SHALL remain a top-level page (no parent shell) and SHALL keep the slug `agents` and the route `/agents` — the slug is public API and SHALL NOT change. The page SHALL be the 素材市场 (Material Market) surface, a nav surface of the 构建 family (per `app-navigation`), and it SHALL carry the product's material markets. It remains the product's single in-product pack doorway: `/packs` redirects into its 智能体 tab (per `pack-marketplace`).

The page SHALL render exactly five sub-tabs, in the unified surface registry's `agentsTabs` order — **智能体（Agents）**, **工具（Tools）**, **技能（Skills）**, **插件（Plugins）**, **我的（Mine）** — with a stable `?tab=` query parameter for deep-linking whose values SHALL be exactly those five slugs in that order: `agents`, `tools`, `skills`, `plugins`, `mine`. No sixth sub-tab SHALL exist on this surface, and the retired single browse tab SHALL NOT return as one.

Each sub-tab SHALL host exactly its species' content: the 智能体 (`agents`) sub-tab SHALL host the pack marketplace's browse / inspect / subscribe surfaces (governed by `pack-marketplace`); the 工具 (`tools`) sub-tab SHALL host the MCP market shelf plus the installed-server roster — list, add, edit, remove, and enable/disable — with credential connect cards remaining in the Settings connections section (per `extension-management-ui`, `connection-center`); the 技能 (`skills`) sub-tab SHALL host the skill market shelf including its external-source zone, plus the installed-skill roster and the user's skill candidates; the 插件 (`plugins`) sub-tab SHALL host the plugin catalogue with its three supply states — 可启用（supplied with the deployment or desktop build; one enable toggle）、未供应（visible in the catalogue and marked 申请供应）、已启用 — with a per-entry enable toggle and the 申请供应 request affordance (per `dsh-plugin-supply`, `plugin-supply-request`); and the 我的 (`mine`) sub-tab SHALL host the user's own pack state unchanged, in two sections — 已安装 (installed snapshots, updates, uninstall) and 我的创作 (creator drafts and publish) — with the preset-conversion handoff landing on the 我的创作 section. Subscription, upgrade, uninstall, draft, publish, add, edit, remove, install, toggle, and request-supply behavior SHALL be preserved exactly as governed by their own capabilities; only the surface and route container moves.

The tab set SHALL be rendered from the unified surface registry resolved through the layout chain (per `layout-configuration`): the `agentsTabs` container SHALL carry exactly `agents`, `tools`, `skills`, `plugins`, and `mine`, all listed by every factory preset, with NO tab carrying a marketplace predicate — the `agents` entry is the market's front page and SHALL be present on every deployment; `tools`, `skills`, and `plugins` SHALL likewise always be present, and an empty plugin catalogue SHALL still render its tab with its explanation. Layout resolution may hide or reorder tabs within the same bounds (never defeating a platform predicate). The tuning surface SHALL NOT be a tab of this surface: `/tuning` is its own nav surface in the 构建 family, and `tuning` SHALL NOT be added to the `agentsTabs` container.

Retired sub-tab slugs SHALL stay resolvable through the surface-slug aliases rather than by keeping retired tabs in the tab set: `market` → `agents` (the retired browse tab), `supply` → `agents`, `apps` → `agents` (the legacy Apps tab content lives in the app center, openspec: app-center), `build` → `agents`, and `creations` → `mine`. `agents` SHALL NOT be aliased any more: it is a canonical sub-tab slug. Stale pre-rename links SHALL NOT dead-end or error: `/packs` and `/packages`-style legacy paths SHALL redirect into `/agents?tab=agents`, and an aliased or otherwise unknown `?tab=` value SHALL fall back to the first visible sub-tab rather than rendering an error. The former Experts sub-tab SHALL remain retired — the page SHALL NOT render an expert roster.

The 智能体 sub-tab SHALL render on EVERY deployment. Where the deployment reports no pack marketplace it SHALL render an honest unavailable state — naming that this deployment carries no marketplace and pointing at 我的 for packs already installed (they keep working) — instead of disappearing: a vanished front page opened the surface on 工具 and read as if the market had been removed, which is a worse answer than saying what is true. The 我的 sub-tab keeps local pack management regardless.

Sub-tab selection SHALL persist in the URL. On initial load with no query parameter the 智能体 sub-tab SHALL be active, on every deployment. The retired Settings section routes SHALL keep resolving: `/settings/packs` to `/agents?tab=mine`, and `/settings/presets` to its existing destination — the creations/drafts area, which now lives in the 我的 sub-tab — so existing deep links keep resolving. The retired capability routes SHALL likewise land on their tabs, as owned by `settings-surface`: `/settings/mcp`, `/mcp`, `/extensions`, and `/extensions/mcp` to `/agents?tab=tools`, and `/settings/skills`, `/skills`, and `/extensions/skills` to `/agents?tab=skills`.

The page's own chrome SHALL be built from the foundation primitives rather than hand-rolled: the header SHALL be a `PageShell` (title as the first reading point, actions right-anchored), and the sub-tab strip SHALL be the foundation `Tabs` (single keyboard contract: arrows move selection, Home/End jump to the ends, roving tab index, `aria-selected` on the active tab). The strip's active state MUST NOT be drawn with a coloured border of two pixels or more. This changes paint and keyboard semantics only: the sub-tab slugs, their order, and the `agent-market-tab-<slug>` / `agent-market-panel-<slug>` / `agent-market-page` test ids SHALL remain exactly as specified above, because they are asserted by e2e and act as public API.

The 智能体 sub-tab's cards SHALL state the viewer's relation to each material: a card whose pack has a local installed snapshot SHALL show 已装 with that snapshot's version, and a card whose listed version is newer than the installed snapshot SHALL show 可更新 with the newer version. Both SHALL carry their meaning in words via the status vocabulary, not by colour alone. When either side of the comparison is unavailable — no installed snapshot read, or no listed version — the card SHALL show neither state rather than guessing. This state is informational: it MUST NOT open a sixth sub-tab, alter the `?tab=` contract, gate subscribe or install, or replace the 我的 sub-tab's own installed/update affordances.

#### Scenario: default to the market sub-tab

- **WHEN** the user opens `/agents` with no `?tab` parameter under the factory preset
- **THEN** the 智能体 sub-tab SHALL be active and the marketplace browse/list surfaces SHALL be visible

#### Scenario: default to Agents sub-tab

- **WHEN** the user opens `/agents` with no `?tab` parameter under the factory preset
- **THEN** the first visible sub-tab SHALL be active — 智能体 under the factory preset
- **AND** the former two-tab default SHALL no longer apply, the 智能体 tab being the market's first species in registry order

#### Scenario: sub-tabs are exactly the five species in registry order

- **WHEN** the user opens `/agents` on a marketplace deployment and inspects its sub-tabs
- **THEN** the tabs SHALL be 智能体, 工具, 技能, 插件, 我的, in that order
- **AND** each tab's `?tab=` value SHALL be `agents`, `tools`, `skills`, `plugins`, `mine` respectively
- **AND** no other sub-tab SHALL render

#### Scenario: tools tab carries the MCP shelf and the installed roster

- **WHEN** the user opens `/agents?tab=tools`
- **THEN** the MCP market shelf and the installed-server roster SHALL render in that tab, with their add, edit, remove, and toggle affordances
- **AND** no credential connect card SHALL render in the shelf — the connect cards remain in the Settings connections section

#### Scenario: skills tab carries the shelf, the external zone, and the installed roster

- **WHEN** the user opens `/agents?tab=skills`
- **THEN** the skill market shelf with its external-source zone, the installed-skill roster, and the user's skill candidates SHALL render in that tab
- **AND** installing an external skill SHALL still pass through its consent panel before anything is installed

#### Scenario: plugins tab carries the three supply states

- **WHEN** the user opens `/agents?tab=plugins`
- **THEN** the catalogue SHALL mark each supplied bundle 可启用 unless already enabled, show 已启用 for an enabled bundle, and mark a catalogue entry the deployment does not supply 未供应 with a 申请供应 action
- **AND** a supplied bundle's enable toggle SHALL apply through the plugin-supply bridge
- **AND** when the deployment supplies nothing, the tab SHALL still render with the catalogue's explanation

#### Scenario: deep-link to the mine sub-tab

- **WHEN** the user navigates to `/agents?tab=mine` on a marketplace deployment
- **THEN** the 我的 sub-tab SHALL be active, with 已安装 and 我的创作 both rendered

#### Scenario: deep-link to Market

- **WHEN** the user navigates to `/agents?tab=market` on a marketplace deployment
- **THEN** the value SHALL normalize to `agents`, the 智能体 sub-tab SHALL be active, and the browse/list surfaces SHALL be visible

#### Scenario: deep-link to Apps

- **WHEN** the user navigates to `/agents?tab=apps`
- **THEN** the 智能体 sub-tab SHALL be active, no Apps sub-tab SHALL render, and the app-center content SHALL remain at `/apps` (per `app-center`)

#### Scenario: retired tab slugs resolve through the surface-slug aliases

- **WHEN** the user navigates to `/agents?tab=creations`, `/agents?tab=supply`, `/agents?tab=apps`, or `/agents?tab=build`
- **THEN** `creations` SHALL resolve to the 我的 sub-tab, and `supply`, `apps`, and `build` SHALL resolve to the 智能体 sub-tab
- **AND** `?tab=agents` SHALL be the canonical value selecting the 智能体 sub-tab, not an alias
- **AND** no retired tab SHALL render as a selectable sub-tab, and no expert roster or app entry list SHALL render on this surface

#### Scenario: stale packages links land on the agents tab

- **WHEN** the user follows a `/packages`-style stale link (or the older `/packs` pathway)
- **THEN** the router SHALL resolve to `/agents?tab=agents` without an error page, and the 智能体 sub-tab SHALL be active

#### Scenario: 我的 contains installed and creations

- **WHEN** the user opens the 我的 sub-tab
- **THEN** installed packs with versions and update affordances render under 已安装, and the user's drafts with publish affordances render under 我的创作
- **AND** the preset-conversion handoff lands on 我的创作

#### Scenario: tab selection persists across reloads

- **WHEN** the user selects the 我的 sub-tab and reloads the page
- **THEN** the URL SHALL carry `?tab=mine` and the 我的 sub-tab SHALL be active on load

#### Scenario: resolved layout hides a sub-tab

- **WHEN** the resolved layout for a user omits the 智能体 sub-tab
- **THEN** the page renders without the 智能体 tab, a `?tab=agents` deep link falls back to the first visible sub-tab, and no error surfaces

#### Scenario: first visible tab active on narrowed presets

- **WHEN** the resolved layout hides the 智能体 tab (e.g. a mine-only preset) and the user opens `/agents` without a parameter
- **THEN** the first visible sub-tab SHALL be active — 工具 under a five-species preset, 我的 under a mine-only preset

#### Scenario: Market tab is absent without a marketplace

- **WHEN** the deployment does not report the pack marketplace
- **THEN** the page SHALL render all five sub-tabs, 智能体 first and active by default (the tab is not absent any more — its CONTENT is),
- **AND** the 智能体 panel SHALL state that this deployment carries no marketplace and SHALL point at 我的 for already-installed packs
- **AND** no empty market shell (a marketplace browse surface with nothing behind it) SHALL render

#### Scenario: 调优 is not a tab of the market surface

- **WHEN** the user opens `/agents` and inspects its sub-tabs
- **THEN** no 调优 tab SHALL be present among the five species, and `/tuning` SHALL render as its own nav surface in the 构建 family

#### Scenario: retired Settings sections redirect into the page

- **WHEN** the user navigates to `/settings/packs` or `/settings/presets`
- **THEN** both SHALL redirect to `/agents?tab=mine` — the former opening 已安装, the latter its existing destination, the 我的创作 area — so existing deep links keep resolving
- **WHEN** the user navigates to `/settings/mcp`, `/settings/skills`, or `/settings/plugins`
- **THEN** each SHALL redirect to `/agents?tab=tools`, `/agents?tab=skills`, and `/agents?tab=plugins` respectively (per `settings-surface`)

#### Scenario: an installed material says so on its card

- **WHEN** the user opens the 智能体 sub-tab and one listed pack has a local installed snapshot at v3
- **THEN** that pack's card shows 已装 v3 in words, and packs without a snapshot show no installed state at all

#### Scenario: an available update says so on its card

- **WHEN** a listed pack is published at v4 while the local snapshot sits at v3
- **THEN** the card shows 可更新 v4, and the 我的 sub-tab's own update affordance is unchanged

#### Scenario: missing state is not guessed

- **WHEN** the installed-snapshot read fails or a card carries no listed version
- **THEN** the card shows neither 已装 nor 可更新, and the market still renders its rows

#### Scenario: the relation state gates nothing

- **WHEN** a pack is already installed at the latest version and the user subscribes or installs it again
- **THEN** the action proceeds through its normal gate — the card state never blocks or auto-triggers it

#### Scenario: the tab strip keeps its keyboard contract

- **WHEN** the user focuses the sub-tab strip and presses ArrowRight, ArrowLeft, Home, or End
- **THEN** selection moves per the foundation `Tabs` contract and the URL updates to the newly selected `?tab=` value

#### Scenario: the strip's test ids and slugs are unchanged

- **WHEN** the sub-tab strip renders after the chrome change
- **THEN** `agent-market-page`, `agent-market-tab-<slug>` and `agent-market-panel-<slug>` are present exactly as before, with the same five slugs

### Requirement: Catalog schema is unchanged by the agents page relocation
The agents page restructure (Experts / Market / Apps sub-tabs and the migration of the preset and pack management surfaces into the page) SHALL only change rendering surfaces; the entry schema, fetching, merge, role filter, and Nango broker SHALL be preserved unchanged.

#### Scenario: catalog behavior is preserved
- **WHEN** the catalog is served
- **THEN** all three entry types SHALL be returned in `GET /api/catalog` exactly as before

### Requirement: 目录卡的头像纪律与信息层级

智能体目录卡（构建器总门面的供给/创作区沿用同一卡）SHALL 采用统一头像体系：单一色系字母/字形头像或统一图标体系，MUST NOT 以高饱和多色 emoji 拼贴与主操作争夺注意力；卡内信息层级 SHALL 固定为 名称 → 一句话职责 → 状态/统计 → 标签，标签数量上限 3，超出收纳进 Tooltip；主操作蓝色 SHALL 全目录至多每卡一处。

#### Scenario: 头像不抢灯

- WHEN 目录同时渲染 10 张以上智能体卡
- THEN 头像均为统一色系字形/图标，页面不存在多色 emoji 头像墙

#### Scenario: 标签溢出收纳

- WHEN 某卡片标签超过 3 个
- THEN 仅显示前 3 个，其余以 Tooltip 呈现完整清单

### Requirement: 目录派生预设的送达必须收敛

目录（合并后的本地＋云端目录）变更导致 agent 预设 roster 被重写时，部署 SHALL 保证这次
重写**最终送达运行时**：一个因 bridge 未就绪或 runtime 忙而被推迟的重启 MUST NOT 只依赖
「下一次 ready / idle 转移」——若在有限延迟内没有发生转移，部署 SHALL 自行补送，且补送次数
SHALL 有上限。每次目录变更 SHALL 重置该上限。用尽上限后 SHALL 保留待送状态等下一次转移，
并在日志里留下可读的一行，MUST NOT 以紧循环重试。

宿主侧「已在位」的判断 MUST 与子进程实际可用的预设一致：roster 写盘而子进程未重启到它时，
部署 MUST NOT 对外宣称该预设可选。

「推迟」与「失败」SHALL 分开计量：一次因 bridge 未就绪或 runtime 忙而没有发起的重启
MUST NOT 计入失败补送的上限——实测（2026-11-14 整轮 e2e）三次推迟全部落在同一段忙碌里，
共享额度当场用尽，此后补送再没有发生，而那段忙碌本身就保证了「下一次空闲转移」不会在
测试的 90 秒窗口内到来。推迟 SHALL 按固定的、非紧循环的节拍继续查看（默认 5 秒），
并另有自己的（远大于失败额度的）上限。

#### Scenario: 撞车后的补送

- **WHEN** 目录变更写入 roster 后，重启因 bridge 正在重启或仍有回合在流而被推迟，且随后一段时间内没有任何 ready / idle 转移
- **THEN** 部署在有限延迟后自行重试这次重启（runtime 仍忙则不重试、继续等待），送达后 roster 与子进程一致

#### Scenario: 补送有上限，不 spin

- **WHEN** 同一次目录变更的补送连续失败达到上限
- **THEN** 停止补送、保留待送状态、留下一行点名原因与目录内容的日志，等下一次目录变更或运行时转移再继续

#### Scenario: 新的一次目录变更重置额度

- **WHEN** 上一次目录变更的补送额度已用尽，随后目录再次变更
- **THEN** 补送计数归零，新的一轮按同一上限重新计数

#### Scenario: 新 agent 在负载下仍能出现在选人面

- **WHEN** 用户订阅了一个带 agent 的包，而此刻运行时正在处理别的回合（忙）
- **THEN** 该 agent 在其后的一次空闲窗口内出现在预设 roster 里并可被选中；MUST NOT 出现「目录里有了、选人面里没有」的长期状态

#### Scenario: 一段忙碌不消耗补送额度

- **WHEN** 目录变更写入 roster 后 runtime 持续忙碌，等待窗口内没有空闲转移，且期间多次查看
  都因「忙」被推迟
- **THEN** 这些推迟不计入失败补送的上限；runtime 空闲后的下一次查看即完成重启并送达，
  不依赖是否发生过 ready / idle 事件

#### Scenario: 失败与推迟各自有上限

- **WHEN** 重启本身连续失败达到上限
- **THEN** 停止补送并保留待送状态（推迟的查看额度与之独立，不会因为失败额度用尽而被
  提前耗尽，也不会因为一次漫长的忙碌而把失败额度算掉）
