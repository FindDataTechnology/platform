# Proposal: add-pack-marketplace

## Why

Capability bundles (MCP servers + skills + agents) already exist as a proven demo format — the four vertical packs — but only as an operator-side convention assembled by hand across five systems (registry registration, `registry-groups.json`, cloud `agents.json`, Logto organizations, per-entry manual installs). "Pack" is not a first-class object anywhere: users cannot author one, share one, or acquire one in a single action. As the platform opens to external creators, user-authored packs published to a shared marketplace are a core product capability, not an ops convenience.

## What Changes

- **Pack becomes a first-class, user-authorable object**: a versioned manifest bundling inline skill content (SKILL.md), references to registry-registered MCP servers, and agent persona entries.
- **Gateway-level pack registry** (new SQLite store, following the shares-registry pattern): publish, browse/search, detail, subscribe/unsubscribe, and update-availability APIs, keyed on the gateway's verified identity.
- **Publishing is identity-gated**: only users whose platform groups include `creators` (a Logto organization, same mechanism as `legal`/`analysts`) can publish. All authenticated users can browse and subscribe.
- **Pack authoring surface in the author's cell**: draft editing (skill bodies, MCP reference picking from market entries, agent persona) with drafts stored in the author's cell; publish pushes the manifest to the gateway, which stamps the author and freezes the version. Published versions are immutable; a new publish creates the next version.
- **One-click subscribe**: the subscriber's cell materializes the pack snapshot in one action — skills into the custom-skills store (hot-reloaded), MCP references into the extension store (reusing per-user registry credentials; no secrets ever transfer), and agent entries into the cell's agent catalog as a new source, compiled to local persona presets by the existing path.
- **Snapshot subscription semantics**: subscribing installs the current version; when the author publishes a new version, subscribers see an update affordance and upgrade explicitly. No automatic propagation.
- **v1 security boundary**: pack MCP entries may only reference registry-registered servers — no arbitrary endpoints. Pack agents are persona-only (no arbitrary `baseUrl`). Author-supplied MCP services and remote-forwarding agents are deferred to a future change.
- **Seeded content**: the four vertical packs (法律-合同, 法律-案件, 数据-股票, 数据-中国经济) are republished by operators as the first packs in the marketplace, upgrading the demo flow from "install 3 entries" to "subscribe to 1 pack".

## Capabilities

### New Capabilities

- `pack-authoring`: the pack definition model (manifest shape, content rules, validation), the in-cell draft editor, and the publish flow from the author's cell to the gateway.
- `pack-marketplace`: the gateway pack registry — publishing gate, immutable versioning, browse/search/detail APIs, subscription records, and update availability; plus the Store-side pack browsing UI.
- `pack-installation`: what a subscription does inside the subscriber's cell — batch materialization of skills, MCP references, and agent entries; conflict and partial-failure handling; version snapshot, update, and unsubscribe semantics.

### Modified Capabilities

- `agent-catalog`: the catalog gains a fourth source — agent entries from packs subscribed in the cell — with defined merge precedence (pack entries win over registry, lose to local `agents.json` and the cloud document; same role-gating and persona-preset compilation as other `chat` entries).

## Impact

- **Gateway** (`gateway/`): new pack registry module + REST routes beside the share registry; identity already available (`email` + `groups`).
- **Cell backend** (`server.js`, new pack store module): draft storage, subscribe/materialize endpoints, pack catalog source in `catalog.js`, batch install path over `extension-store.js` and the custom-skills/skill-materialization pipeline.
- **Web UI**: Store gains a Packs section (browse/detail/subscribe/my-packs); pack editor for creators.
- **Ops**: one Logto organization (`creators`) + member management; republishing the four vertical packs as seeds.
- **Out of scope (v1)**: author-supplied MCP endpoints, automatic update propagation, pricing, mini-program pack browsing, pack-to-pack dependencies.
