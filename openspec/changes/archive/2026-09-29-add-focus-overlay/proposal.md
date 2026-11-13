# Proposal: add-focus-overlay

## Why

Persona-level focus (add-persona-resource-sets) narrows a role to exactly what its pack declares — but the subscriber has no say: a role that would be perfect with one extra server (say, the operator's websearch) or without one noisy skill still ships the pack's set as-is. Users need per-role adjustment without waiting on the pack author. The spec's no-persisted-scope invariant ("SHALL NOT persist as independent state that can drift from the preset") blocks a naive stored resource set — the overlay must be a **preference diff** (ADR-0001): add/remove lists that re-compose over the derived set at every composition point, so nothing can go stale.

## What Changes

- Users (any authenticated client) can adjust a focused role's effective set: **add** MCP servers or skills, **remove** MCP servers or skills. Adjustments apply to the next session via the existing serialized runtime-mutation path and are rejected while a turn streams — the same contract as a preset switch.
- Storage is a **per-role preference diff** (add/remove name lists keyed by the preset), never a snapshot of the set. It composes after the persona's derived set at every derivation point (boot, preset switch, MCP/skill CRUD, crash respawn): additions may only draw from the user-enabled universe (a disabled server can never be resurrected by overlay), removals are always legal and may drop baseline items (user-level narrowing, consistent with how availability can already disable a baseline server globally).
- **Self-healing on drift sources**: a pack upgrade that adds/drops/renames resources re-resolves the diff against the new derived set — dangling entries silently converge; no error states, nothing to repair by hand.
- Skills overlay rides the **compose-root mechanism** (ADR-0002): the persona's effective root is rebuilt at composition as (declared-or-whole-pack set ± overlay), intersected with locally-available skills. An overlay on an undeclared persona forces a compose root for that role (otherwise today's pack-root path is byte-identical).
- Web picker gains a per-role **资源微调 panel**: the effective set with per-item remove, plus addable servers/skills drawn from the enabled/installed universe. Miniprogram parity is a fast-follow, not a gate.
- The pack-agent-scoping invariant is **reworded, not broken** (ADR-0001): effective scope ≡ f(selected preset, that preset's overlay) — still derived at every composition, still no snapshot.

Non-goals: custom presets (change ③); per-user overlays on shared cells (v1 overlay is deployment-global, like preset selection — per-client scoping is the documented upgrade path); overlay on full-mode presets (shipped presets keep the existing availability semantics — overlay applies to pack-persona roles only); pack manifest changes (creator side untouched); MP UI in this change.

## Capabilities

### New Capabilities

- `focus-overlay`: the subscriber-side adjustment semantics — preference-diff storage, add/remove rules (enabled-universe additions, always-legal removals incl. baseline), upgrade/drift self-healing, effective-root composition for skills, and the web adjustment panel.

### Modified Capabilities

- `pack-agent-scoping`: the derivation invariant admits the overlay input ("derived from the selected preset **and its overlay**", still no independent scope state); focused-mode composition gains the overlay layer applied after the persona set; the shared-runtime requirement extends to overlay state (every client sees the same adjustments, mutations follow the serialized path).

## Impact

- **Code**: `dsh-profile.js` (composition pipeline: focus layer + overlay in both patch writers), `skill-materialize.js` (effective-root build gains overlay input), `server.js` (overlay GET/PUT routes on the runtime-mutation path; boot carries overlay), `db.js` (preference read/write — existing preferences store, no schema change), web picker (资源微调 panel).
- **Depends on**: add-persona-resource-sets (resolvePersona export, compose-root builder). Deploys serially after it.
- **No changes**: pack manifests and market plane, dsh packages, MP client, availability-overlay semantics (which stay global and subtractive, untouched).
- **Ops**: nothing new to configure; deployment-global semantics documented in the deploy notes; probe extended to show the overlay's effect on a role's surface.
