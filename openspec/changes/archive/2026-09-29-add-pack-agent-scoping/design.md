# Design: add-pack-agent-scoping

## Context

The runtime's resource surface is assembled from two host-written cordis patch files: `mcp.patch.yml` (one dsh-mcp-client loader entry per server, merged from mcp.json + the extensions DB + personal overlay, `dsh-profile.js writeMcpPatch`) and `skills.patch.yml` (a single `customSkillDirs` root list, `dsh-profile.js writeSkillsPatch`). Production call sites are exactly three: boot (`server.js:355` / `server.js:386`) and the `ctx.dshUpdateMcp` closure (`server.js:487`); REST, bindings, and pack installs all funnel through the latter. Preset switching already restarts the child (`switchPresetToInner` → `dshBridge.restart({ agentPreset })`) and persists `agent.preset`. Pack skills today materialize flat into the shared `custom-skills/<name>/` root with pack ownership only in the DB (`originPackId`); pack MCP references install as untagged shared rows, but the installed-pack state keeps the manifest, and the catalog's pack source already attaches `packId` to pack agent entries. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- Selecting a pack persona narrows MCP servers + skills to baseline ∪ the pack's resource set; everything else keeps today's full surface.
- Scope correctness survives boot, crash, MCP CRUD, pack upgrade/uninstall, and cron-job preset switches with no independent state to maintain.
- Zero dsh changes, zero manifest schema changes, no migration action for already-installed packs.

**Non-Goals (design-level):**
- No per-client or per-session scoping (deployment-global, next-session — preset semantics unchanged).
- No trimming of the composition's built-in dsh tool rows; no skill hot-swap without restart; no manifest exclusion fields (v2 would turn the resource set from a derived view into a declared one).

## Decisions

### D1 — Scope is a derived invariant, not switch-time state

Effective scope ≡ f(current preset): pack persona preset ⇒ focused; shipped presets / `local` ⇒ full. The derivation (preset id → catalog entry → `packId` → installed-pack manifest → pack-owned skill rows + MCP `registryName`s, intersected with installed servers) is a pure function evaluated inside the two patch writers, so boot, `dshUpdateMcp`, preset switches, and crash respawns all produce consistent patches with no scope preference and no invalidation hooks. The cron runner's per-job preset switch works unchanged — scope follows the preset for free. Alternative (explicit `agent.scope` preference written at switch time) rejected: every invalidation hook it needs (uninstall, catalog change, crash restore) is exactly what derivation gets for free, and a drifted scope state is a silent correctness bug.

### D2 — One restart carries persona + both patches; skills ride a same-path rewrite

`restart({ agentPreset })` is the only existing preset-apply path, and `restart` accepts `mcpPatchPath` but **not** `skillsPatchPath` (verified `dsh-bridge.js:290` — the field is constructor-only). No bridge change is needed: `skills.patch.yml` lives at a fixed path the child re-reads at spawn, so the switch path rewrites both patch files at their existing paths (via the scoped writers) and then issues the one restart. MCP CRUD while focused keeps today's HMR hot-swap — the rewrite already carries the scope filter because it lives inside the writer.

### D3 — Pack skills materialize into a per-pack root

`customSkillDirs` is a flat list of skill roots (verified `dsh-skill-filesystem lib/index.js`: each entry is pushed as one discovery root; no nested recursion). So scoping skills = choosing which roots to list. Pack-owned rows materialize under `custom-skills/packs/<packId>/<skill>/SKILL.md`; user-authored rows keep the flat user root. Full mode lists the user root + every pack root; focused mode lists the deployment `skills/` root + the focused pack's root. `rebuildFromDb` reconciliation extends to the pack root, which also gives the no-action migration: old flat pack-skill dirs are wiped as stale and rewritten into the pack root from the durable DB on first boot.

### D4 — Baseline is operator-owned layering, not a pack-visible concept

MCP baseline = every mcp.json server (operator layer, always) ∪ `PACK_BASELINE_MCP` env names (resolved against installed servers; unresolvable ⇒ warn + skip, the envRefs convention). Skills baseline = the deployment `skills/` root, unconditionally. No `PACK_BASELINE_SKILLS` in v1. Authors see neither. Alternative (baseline only = mcp.json) rejected: fd-prod's websearch-class servers are registry installs, and forcing them into mcp.json would blur the operator/registry layers.

### D5 — Collision truth is the install report, not the manifest

A skill skipped at install (foreign owner of the same name) is outside the resource set even though the manifest lists the name; MCP refs intersect with actually-installed servers (missing refs already carry their unavailability in the install report). This mirrors the catalog pack source's rule (`catalog.js` — only `report.status === "installed"` agents enter the catalog) and is what D3's directory mechanism naturally computes.

### D6 — Focus visibility is persona text + serialized `packId`

`catalogEntryPersona` appends the focus note for pack-sourced entries (static text — the persona is per-entry, and every pack entry is focused by definition), and the catalog serializer passes `packId` through for the picker badge. The "unavailable tool" honesty requirement is satisfied by the persona note (the model learns from the persona how to answer), not by any tool-interception machinery. Resolved-set counts in the badge are optional polish.

## Risks / Trade-offs

- [Old sessions resumed under a changed scope reference tools the child no longer has] → Same pre-existing failure mode as disabling an MCP server mid-conversation; mitigated by the persona note and the existing next-session semantics. No new machinery.
- [fd-prod's real tool counts are estimates (163+ was probed, per-server counts unknown)] → The measurement probe runs before/after rollout; the ~20–40 target band is an expectation, not a gate.
- [Watched-dir set changes at runtime (skills patch HMR) are unverified dsh behavior] → Not relied upon: scope changes ride the restart; only content changes inside already-listed roots use Chokidar hot-reload.
- [Two packs referencing the same MCP server] → Shared by design (reuse semantics); focusing either pack keeps the server — the intersection model needs no per-pack MCP ownership.
- [PACK_BASELINE_MCP drift across deployments] → Documented in the ops runbook next to `PACK_MARKETPLACE` (docs/pack-marketplace.md).

## Migration Plan

Deploy is additive: writers gain an optional scope, materialization gains a pack root (first boot re-materializes from the DB), catalog serialization gains `packId`, UI gains a badge. Rollback = revert the deploy; the DB schema is untouched and full mode regenerates the old patches on next boot. No gateway/market coordination needed.

## Open Questions

None blocking. fd-prod's `PACK_BASELINE_MCP` value (which servers deserve baseline status there) is an ops decision at rollout time, not a design input.
