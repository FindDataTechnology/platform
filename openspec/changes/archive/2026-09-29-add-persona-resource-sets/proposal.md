# Proposal: add-persona-resource-sets

## Why

The glossary defines a resource set (资源集) as the skills and MCP servers tied to **one role**, but the shipped implementation derives it per **pack**: every persona of a multi-agent pack focuses to the same pack-wide set — the coarsest possible cut, so a pack mixing a contract reviewer and a case analyst pays for both tool surfaces on every turn of either. v1 deliberately deferred this (its non-goals: "manifest editor exclusion fields (v2 — would flip the resource set from derived to declared)"). Two related costs are unmanaged: persona text may run to 16K chars (≈ half a small model's usable context, paid every turn), and the deployment baseline has never been audited. This change closes the gap and is the groundwork change of the resource-optimization program (followed by subscriber-side overlay and custom presets).

## What Changes

- Pack manifest agent entries gain an **optional resource declaration**: `agents[i].resources = { skills: [...], mcpServers: [...] }`, validated as a subset of the pack's own declared skill names and MCP registry references. **Undeclared = the whole pack set** (existing packs and drafts upgrade with zero action); an **empty declaration is legal** (persona-only role → baseline alone); packs still cannot extend the deployment baseline.
- `deriveScope` is refactored to a multi-input derivation (preset → persona entry → effective set) — a pure-rearrangement groundwork step with no behavior change, the composition point the follow-up changes (overlay, custom presets) will feed.
- Focused mode composes **per persona**: the MCP keep-set follows the persona's declaration; skills scope via a **persona compose root** — `custom-skills/packs/<packId>/personas/<agentId>/` holding symlinks into the pack root, rebuilt from the durable store at every patch write (ADR-0002: roots are disposable). Full mode is unchanged (the flat scan ignores the nested `personas/` directory; dsh follows symlinks — both verified against `dsh-skill-filesystem` source).
- Manifest validation extends in the **one shared validator** (`lib/pack-manifest.js`): the gateway's publish endpoint and the cell's install endpoint enforce the subset rule identically.
- The creator editor gains **per-agent resource pickers** (offering only the draft's own skills and MCP references) and a **persona cost readout** (≈ tokens per turn) — guidance, not a hard cap (a tightened cap would strand old packs' upgrades behind re-validation).
- The agent picker badge refines from pack identity to **role-level resource summary**; the scope probe reports **per-persona** server/tool counts and token deltas.
- The 4 marketplace seed packs are republished with declarations — a live exercise of the declared-upgrade path (spec scenario: upgrade re-derives the set).
- Ops checklist (documented, not spec'd): audit the deployment `skills/` baseline; review `PACK_BASELINE_MCP` entries per role family.

Non-goals: subscriber-side add/remove on top of a role's set (follow-up change ②); user-composed custom presets (change ③); cross-pack references inside manifests (power belongs to the overlay layer — packs stay self-contained products); per-client scoping (v1 ceiling); miniprogram UI parity (fast-follow, not blocking); hard persona length limits; on-demand tool-schema loading (parked, upstream dsh territory).

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `pack-agent-scoping`: focused composition narrows from the pack's resource set to **the selected persona's declared subset** (undeclared → whole pack, empty → baseline only; derivation still an invariant of the selected preset, never stored); skill scoping gains persona compose roots; the visibility requirement refines badges to role-level summaries; the measurement requirement reports per persona.
- `pack-authoring`: agent entries carry optional resource declarations; the editor offers per-agent pickers constrained to the draft's own skill and MCP lists, and surfaces a persona token-cost readout.
- `pack-marketplace`: the manifest-validation requirement extends to per-agent declarations — the subset-of-own-pack rule is enforced at publish and re-validated at install.

## Impact

- **Code**: `dsh-profile.js` (deriveScope multi-input + persona resolution; writeSkillsPatch lists persona roots), `skill-materialize.js` (compose-root build/rebuild from DB rows), `lib/pack-manifest.js` (subset validation), `catalog.js` + web picker (role-level badge data), web pack editor (per-agent pickers, cost readout), `scripts/probe-pack-scope.mjs` (per-persona report). Gateway publish path picks up validation via the shared validator.
- **No changes**: dsh packages (symlink-following and flat-scan behavior verified, not modified), pack-installation behavior (the manifest snapshot already carries whatever it declares; compose roots are runtime artifacts), existing installed-pack data.
- **Data/ops**: seed packs republished at new versions; baseline audit + `PACK_BASELINE_MCP` review documented in the deploy notes; acceptance measured by the extended probe (per-persona tool counts vs the full roster, token delta per role).
