# Proposal: add-pack-agent-scoping

## Why

v1 pack subscription installs skills and MCP servers globally: every turn ships the full tool roster (163+ MCP tool schemas on fd-prod) plus every skill description, regardless of which role is active — a fixed token cost on every request, and small models mis-pick tools on ~190-tool rosters (the vertical-packs lesson). Selecting a pack agent today only swaps the persona text; the resource surface never narrows. Selecting a role should mean focusing on that pack's resource set (聚焦模式), so context shrinks and tool selection sharpens.

## What Changes

- Selecting a pack persona preset now runs **focused**: the runtime loads only the deployment baseline plus the pack's own resource set (pack-owned skills + the pack's installed MCP references). Shipped presets (`standard` / `code` / `minimal` / `cordis`) and the built-in `local` agent keep today's full surface.
- Resource scope is a **derived invariant** — effective scope ≡ f(selected preset), recomputed at boot, on every preset switch, and on every MCP/skill mutation. No new persisted state; a stale patch file self-heals on the next write or restart.
- Pack skills materialize under a **per-pack directory** (`custom-skills/packs/<packId>/`); the skills patch (a flat `customSkillDirs` root list) scopes by listing directories. Existing installed packs re-materialize automatically on first boot after upgrade — the DB is the durable store, no user action.
- **Baseline** (always loaded, every mode): MCP = mcp.json servers ∪ `PACK_BASELINE_MCP` env names; skills = the deployment `skills/` root. Operator-owned; pack authors are unaware of it.
- Pack persona text gains a focus note; the agent picker badges pack roles with their pack identity (catalog serialization carries `packId`).
- Scope applies on the existing preset-switch restart — one restart carries persona + both patch rewrites (no dsh changes; `skills.patch.yml` is rewritten at the same path rather than passed to `restart`).

Non-goals: cross-pack resource references; session-level scoping (v1 is deployment-global, next-session, matching the existing preset semantics); hot-swapping the skills patch without restart; trimming the composition's built-in dsh tool rows; manifest editor exclusion fields (v2 — would flip the resource set from derived to declared); a resolved-set settings view; payments, auto-update propagation, miniprogram client work.

## Capabilities

### New Capabilities

- `pack-agent-scoping`: the focused/full resource-scoping semantics — derivation from the selected preset, baseline composition, collision truth (install report), personal-overlay intersection, pack-scoped skill materialization, focus visibility (badge + persona note), deployment-global semantics, and the measurement probes.

### Modified Capabilities

- `pack-installation`: "Pack agents run as local personas" currently promises ALL installed skills and MCP tools; reworded to run composed with the pack's resource set plus the deployment baseline (cross-referencing pack-agent-scoping).
- `agent-catalog`: pack-sourced entries carry their `packId` in the client payload (for the focus badge), and the generated persona text for pack-sourced entries appends the focus note.

## Impact

- **Code**: `dsh-profile.js` (scope derivation helper; `writeMcpPatch` / `writeSkillsPatch` gain a scope filter; `catalogEntryPersona` focus note), `skill-materialize.js` (pack-scoped root + reconciliation), `pack-store.js` (materialize into the pack dir), `server/agent-session.js` (preset switch re-derives scope before restart), `server.js` (boot + `dshUpdateMcp` carry scope), `catalog.js` (serialize `packId`), web UI (picker badge).
- **No changes**: dsh packages, pack manifest schema (v1 derives the default association), gateway/market plane, existing installed-pack data.
- **Ops**: new env `PACK_BASELINE_MCP` (fd-prod should list e.g. websearch); acceptance measured by a static patch probe plus a turn-tracing token comparison (same prompt, same model, full vs focused).
