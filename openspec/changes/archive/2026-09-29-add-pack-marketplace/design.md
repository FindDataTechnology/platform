# Design: add-pack-marketplace

## Context

Today a "pack" (MCP servers + skills + agents) is an operator-side convention assembled by hand across five systems (registry registration, `registry-groups.json`, cloud `agents.json`, Logto organizations, manual per-entry installs) — see `docs/vertical-packs.md`. The pieces a pack composes over already exist as product machinery:

- **Gateway**: verified identity (`email` + `groups`) on every request; a precedent for gateway-level cross-cell persistence (the share-token SQLite registry in `gateway/share.js`); the ability to reach any user's cell.
- **Cell**: custom-skills store with hot materialization to `SKILL.md` (`skill-materialize.js`); MCP install from the market catalog with per-user registry credentials (`extension-store.js`, `registry-bridge.js`); a multi-source agent catalog compiled to local persona presets (`catalog.js`, the "§6.1" path documented in `docs/vertical-packs.md`).
- **Market UI**: the Store's market/installed tabs, `market_changed` / `catalog_changed` WS events.

One cell per user and "secrets stay server-side" are binding constraints: nothing a user authors can live only in their cell if others must see it, and no credential may travel inside a pack.

## Goals / Non-Goals

**Goals:**

- Reuse all three existing install pipelines (skills, MCP, agent presets) — a pack is an orchestration over them, not a fourth install path.
- Additive-only migrations; existing behavior unchanged when no packs exist (the fourth catalog source is empty).
- No new server-to-server authentication machinery in v1.
- The marketplace degrades gracefully in local (non-gateway) deployments — pack surfaces simply do not appear.

**Non-Goals** (beyond the proposal's v1 exclusions):

- Live update push (WS broadcast when a subscribed pack publishes) — badge-on-view only.
- Cross-device draft sync; drafts are cell-local.
- Pack health indicators (stale registry references) beyond per-part install reporting.

## Decisions

### D1. Pack store at the gateway, own SQLite file

A new pack registry module beside the share registry: its own SQLite file at the gateway data root, `CREATE TABLE IF NOT EXISTS` bootstrap, tables `packs`, `pack_versions`, `subscriptions`. Cells stay unaware of each other; the gateway is the only component every user already reaches with a verified identity.

Alternatives rejected: an entity in mcp-gateway-registry (third-party system, admin-gated writes, schema work outside this repo, and its skill model — GitHub-hosted content with baseline drift — is exactly what we avoid); cloud manifest URLs like `AGENTS_CONFIG_URL` (no UGC, no subscription state); per-cell storage (invisible cross-user).

### D2. Publishing gate reuses groups; constant mirrors `ADMIN_GROUPS`

`PACK_CREATOR_GROUPS` env (default `creators`), checked against the gateway-verified `user.groups` — the same mechanism as `isAdminUser`. Membership is managed as a Logto organization (the proven `legal`/`analysts` pattern; Logto roles claims are a proven dead end, organizations work). The gateway stamps author email and time at publish; manifests carry no author-controlled identity.

### D3. Server-minted unguessable pack identifiers; display names are not unique

Pack ids are gateway-minted random (≥96 bits, share-token style). Authors never choose ids; display names may duplicate freely. This eliminates namespace contention, id squatting, and identifier-borne PII in one move, and makes "fork by starting a new draft" the only duplication path.

### D4. Immutable versions; unpublish means unlisted

Publish appends version N+1 with the full manifest; nothing ever mutates a stored version; unpublish sets an `unlisted` flag (browse/detail hide it, subscribers keep their snapshots — materialized content is cell-local and lifecycle-independent). Drafts stay editable after publish for preparing the next version.

### D5. Skill bodies are inline manifest content

The manifest embeds each skill's full body. Alternative rejected: GitHub-hosted SKILL.md via the registry (the current vertical-packs approach) — it requires creators to host content, and the registry's content-baseline drift detection auto-disables skills on any upstream edit (a documented operational hazard). Inline content makes the published manifest the single frozen source of truth and keeps v1 creators dependency-free.

### D6. MCP entries are registry-name references; the v1 security boundary

A pack's MCP entry is `{ registryName }` plus display metadata, nothing else. Publish validation rejects any entry carrying a URL or command config; the pack cannot introduce an endpoint the operator has not registered. Resolution happens at subscribe time through the cell's existing market catalog and per-user registry credential (the registry entry's own group gating and egress-credential machinery apply unchanged). Publish-time existence checking is deliberately not done (it would couple the gateway to the registry); a stale reference surfaces as a per-part install report item.

### D7. Pack agents are persona-only, synthesized into the catalog

Pack agent entries carry display name, persona text, tags, icon — no `baseUrl`, `model`, or `apiKeyEnv` (publish validation rejects them). Materialization synthesizes chat-mode catalog entries that follow the existing local-persona serving path (§6.1): the persona runs on the platform's currently selected model with all local tools and skills. This rejects both the exfiltration surface of arbitrary endpoints and the "bare LLM" forwarding path whose demo failures motivated §6.1 in the first place.

### D8. Browser-mediated flows; no cell→gateway service auth

- Browse/detail/publish/subscribe-records: browser ↔ gateway directly (web session / forward-auth identity — the `/api/share` pattern).
- Materialization: browser POSTs the fetched manifest + version to its own cell's install endpoint; the cell materializes and records installed-pack state.

Alternative — cell-side proxying with a cell service token — is deferred: it adds a new auth surface v1 doesn't need. The tamper concern (a client POSTing a modified manifest to its own cell) is accepted: it is the same trust level as installing a market skill and editing it afterward — own cell, own risk — and the gateway's subscription records remain authoritative for marketplace data.

### D9. Dual state with a clear truth owner

- **Cell** (operational truth): installed packs, versions, per-part state, pack ownership of skills/agents. Drives UI, updates, unsubscribe.
- **Gateway** (advisory): subscription records (user × pack × version × time) for counts and future cross-device features.

Divergence is tolerated and reconciled on demand (the cell never needs the gateway's records to function).

### D10. Conflict policy is uniform: packs never overwrite foreign content

- Skills: `custom_skills` gains pack-ownership columns (`origin_pack_id`, `origin_pack_version`, nullable, additive migration). Install skips — with a reported reason — any skill whose name collides with a non-pack-owned skill; the pack's own rows are replaced on upgrade.
- Agents: ids are author-chosen; collision with another pack's agent id → skip with reason; collision with a registry entry → pack wins (merge order); collision with `agents.json`/cloud → local and cloud win (control plane), per the agent-catalog delta.
- MCP: already-installed servers are reused, never duplicated; MCP configs are never removed on unsubscribe (shared utilities).

### D11. Caps and limits (env-tunable defaults)

Skills ≤ 10 per pack, skill body ≤ 64 KB, agents ≤ 3, MCP references ≤ 5, publish payload ≤ 1 MB, publishes ≤ 10 per author per hour, listing page 50. Rejection reasons name the offending entry.

### D12. Draft storage is a new cell table

`pack_drafts` in the cell's SQLite (id, name, description, tags, entries JSON, updated_at). The editor reuses the custom-skill editing conventions for skill bodies; the MCP picker lists the cell's cached registry market entries; the agent form is persona-only. Drafts are private and cell-local until published.

### D13. Update detection is pull-based

When a packs view loads, the browser compares the gateway's latest version against the cell's installed version and renders the badge; upgrading is an explicit action reusing the install path under the same conflict policy. No push, no auto-propagation.

### D14. API surface (sketch)

- Gateway: `GET /api/packs` (search/tag/paginate), `GET /api/packs/:id`, `GET /api/packs/:id/versions/:v`, `POST /api/packs` (publish, creator-gated), `POST /api/packs/:id/unpublish`, `POST /api/packs/:id/subscribe`, `DELETE /api/packs/:id/subscribe`; creator-owned detail includes subscriber count.
- Cell: draft CRUD (`/api/pack-drafts`), `GET /api/packs/installed`, `POST /api/packs/install` `{packId, version, manifest}`, upgrade and unsubscribe under the installed pack id, each returning the per-part report.
- `catalog.js` gains the pack source (built from installed-pack state, merged per the delta spec order).

### D15. Gateway-fronted deployments only

Pack surfaces (marketplace, editor, installed packs) activate only when the deployment is gateway-fronted; local single-user deployments see no pack UI. This follows the always-degrades-gracefully principle rather than adding a local "fake marketplace".

## Risks / Trade-offs

- [Pack skills are prompt-injection vectors] → creator group is a vetted gate; full skill bodies are inspectable before subscribing (detail view); abuse-report tooling is deferred (see Open Questions).
- [Registry reference drift — a server renamed/removed after publish] → per-part unavailability in the install report, non-blocking; a pack health indicator is deferred.
- [Browser-mediated install allows client-side manifest tampering] → accepted (own-cell trust, same as market installs); gateway records stay authoritative.
- [Two state stores can diverge] → cell is the operational truth; gateway records advisory and only power counts.
- [Skill/agent name squatting across packs] → skip-and-report plus origin tracking; no silent overwrites anywhere.
- [Subscribing without a live registry credential] → the existing connect flow engages for MCP parts; skills and agents install regardless; the report marks the MCP parts as pending connection.
- [Marketplace scale] → SQLite with simple pagination is fine at expected volumes; revisit if listings grow.

## Migration Plan

1. **Schema (additive)**: cell DB — `custom_skills` pack-ownership columns (nullable), new `pack_drafts` and `installed_packs` tables; gateway — new packs SQLite file, bootstrapped `CREATE TABLE IF NOT EXISTS`, nothing to migrate.
2. **Ops**: Logto organization `creators` + member seeding; `PACK_CREATOR_GROUPS` on the gateway (default `creators`).
3. **Seed content**: operators republish the four vertical packs (skill bodies from `docs/vertical-packs/skills/`, MCP references per the composition table, agents from the §6 entries minus endpoint fields).
4. **Rollback**: feature is additive — remove UI entry points and tables lie dormant; the gateway packs file can be dropped independently; with no packs installed, the catalog's fourth source is empty and behavior is identical to today.

## Open Questions

- Abuse reporting / moderation tooling beyond author unpublish (ops-console integration is the natural home — defer to a follow-up change).
- Whether pack agents may declare a preferred model hint (harmless to add later; persona already runs on the selected model).
- Mini-program pack browsing (deferred with the rest of MP feature parity).
- v2: opening registry server registration to creators so packs can carry author-supplied MCP — a separate change touching the third-party registry.
