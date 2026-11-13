# Tasks: add-pack-marketplace

## 1. Gateway pack registry

- [x] 1.1 Create the gateway pack-registry module (own SQLite file at the gateway data root, `packs` / `pack_versions` / `subscriptions` tables, `CREATE TABLE IF NOT EXISTS` bootstrap) following the `gateway/share.js` pattern, and verify with a module-level smoke test that CRUD round-trips a pack with two versions
- [x] 1.2 Implement manifest validation at publish (skill name format and size caps, MCP entries as registry-name references only, persona-only agent entries, per-pack count/size limits from design D11) and verify each rejection class returns a 4xx naming the offending entry
- [x] 1.3 Implement the publish endpoint with the creator gate (`PACK_CREATOR_GROUPS`, default `creators`), server-minted ≥96-bit pack ids, author/time stamping, and append-only versioning, and verify: creator publishes (v1), second publish bumps to v2, non-creator gets an authorization error, stored v1 is unchanged after v2
- [x] 1.4 Implement browse/detail/search endpoints (paginated listing by name/tag, full latest-version manifest including skill bodies, per-version fetch) and verify listing excludes unlisted packs while version fetches still work for retained versions
- [x] 1.5 Implement unpublish (unlist flag, versions retained), subscribe/unsubscribe records, and creator-owned subscriber counts, and verify: unpublish hides from browse but stored versions remain, subscribe records user × pack × version, creator detail shows the count
- [x] 1.6 Add publish abuse controls (per-author rate limit, payload cap) and verify throttled publishes store nothing

## 2. Cell storage and drafts

- [x] 2.1 Add the additive cell-DB migration: `custom_skills` pack-ownership columns (`origin_pack_id`, `origin_pack_version`, nullable) plus new `pack_drafts` and `installed_packs` tables, and verify `npm run migrate` (or startup bootstrap) leaves existing rows intact and creates the new tables
- [x] 2.2 Implement pack-draft CRUD in the cell (create, edit, delete, list; entries stored as JSON per design D12) and verify a draft round-trips with skills, MCP references, and agent entries, and persists across a cell restart

## 3. Cell materialization (subscribe / upgrade / unsubscribe)

- [x] 3.1 Implement the install endpoint's skill part: create `custom_skills` rows with pack-ownership columns, skip-and-report on collision with a non-pack-owned skill, replace pack-owned rows on reinstall/upgrade, and verify the existing materialization pipeline hot-loads the installed skills without a restart
- [x] 3.2 Implement the install endpoint's MCP part: resolve each registry reference through the existing market-catalog install path with the subscriber's registry credential, reuse already-installed servers, and report unresolvable references (missing server, missing group) without blocking other parts, and verify with a pack referencing one present and one absent server
- [x] 3.3 Add the pack agent source to `catalog.js` (built from `installed_packs`, merged in the order built-in → registry → packs → `agents.json` → cloud, no endpoint fields, catalog signature change broadcasts `catalog_changed`) and verify a pack agent appears in `GET /api/catalog`, compiles to a local persona preset, and disappears on uninstall
- [x] 3.4 Implement agent-id conflict handling at install (skip-and-report when another pack owns the same id) and verify the report names the collision while the rest of the pack installs
- [x] 3.5 Implement the per-part install report (installed / reused / replaced / skipped-with-reason / unavailable-with-reason for every skill, MCP reference, and agent) and verify a mixed-outcome install returns a complete report
- [x] 3.6 Implement upgrade and unsubscribe endpoints (upgrade materializes the new version under the same conflict policy; unsubscribe removes pack-owned skills and agent entries, exposes which pack skills were modified after install for the confirmation UI, leaves MCP configurations in place) and verify each returns its per-part report
- [x] 3.7 Implement the installed-packs listing endpoint (pack id, version, per-part state) and verify it reflects install, upgrade, and unsubscribe outcomes

## 4. Marketplace UI (subscriber side)

- [x] 4.1 Add the Store packs section (browse, search by name/tag, detail view showing full skill bodies, MCP references with required groups, and agent personas before subscribe) and verify a logged-in user can inspect every part of a pack before installing
- [x] 4.2 Implement subscribe: one action → cell install call → per-part report displayed, with the existing registry connect flow engaged when an MCP part needs a credential, and verify the e2e flow from browse to a chat that invokes a pack skill and selects a pack agent
- [x] 4.3 Implement My Packs (installed list with versions), the update badge (gateway latest vs installed version, pull-on-view per design D13), and the explicit upgrade action, and verify the badge appears after a new version is published and nothing changes until upgrade is clicked
- [x] 4.4 Implement unsubscribe UI with the modified-skill confirmation, and verify pack skills and the pack agent disappear while MCP configurations remain installed
- [x] 4.5 Gate pack surfaces on gateway-fronted deployments (design D15) and verify a local-mode deployment shows no pack UI and starts normally

## 5. Authoring UI (creator side)

- [x] 5.1 Implement the pack editor's draft management and skill-entry editing (reusing custom-skill editing conventions, client-side validation mirroring publish rules per the pack-authoring spec) and verify draft lifecycle in the UI matches task 2.2's API
- [x] 5.2 Implement the MCP picker (registry-sourced market entries only, no free-form URL/command field) and the persona-only agent form, and verify neither surface offers endpoint, model, or credential fields
- [x] 5.3 Implement the publish action (browser → gateway publish, result and rejection reasons surfaced in the editor, draft remains editable) and verify first publish returns v1, a re-edit and republish returns v2, and a non-creator sees the gate rejection in the editor

## 6. Seeds, docs, and end-to-end

- [x] 6.1 Write the Playwright e2e suite covering the marketplace happy path (creator publishes → user browses/inspects → subscribes → pack skill invocable, MCP connectable, agent selectable and local) and verify it passes in CI
- [x] 6.2 Add e2e coverage for the conflict and lifecycle paths (skill name collision skip, missing MCP reference report, upgrade replaces pack-owned skill, unsubscribe keeps MCP) and verify each scenario's report outcomes
- [x] 6.3 Write the operator runbook section (Logto `creators` organization, `PACK_CREATOR_GROUPS`, republishing the four vertical packs from `docs/vertical-packs/` content) and verify a new operator can follow it to get a seeded marketplace on fd-prod
