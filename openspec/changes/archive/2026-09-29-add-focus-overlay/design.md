# Design: add-focus-overlay

## Context

The composition pipeline today (post add-persona-resource-sets): both patch writers in `dsh-profile.js` derive scope from the selected preset via `resolvePersona` + `deriveScope`; `writeMcpPatch` layers mcp.json ∪ DB servers (enabled/groups/credential-resolved) → availability overlay (subtractive) → focus keep-set (baseline ∪ persona refs); `writeSkillsPatch` lists the baseline root plus the persona compose root (or pack root when undeclared). `resolvePersona` is exported for this change. See proposal.md for motivation, ADR-0001 for the preference-diff contract.

## Goals / Non-Goals

**Goals:**

- Overlay as a pure additional input to the existing derivation — one composition point, no second code path.
- Byte-identical behavior when no overlay exists (absent preference key ⇒ today's patches, byte-for-byte).
- Self-healing without GC ceremonies: dangling entries are inert at composition; no migrations, no error states.

**Non-Goals:**

- Custom presets (change ③); per-user overlays (deployment-global v1 ceiling); overlay on full-mode presets; MP panel (fast-follow); pruning/repair UI for dangling entries.

## Decisions

### D1 — Storage: one preference key per preset

`focus.overlay.<presetId>` in the existing preferences store (`agent.preset` precedent), value `{ addMcp: [], removeMcp: [], addSkills: [], removeSkills: [] }`. Write path validates string arrays, dedupes, and rejects a name present in both add and remove for the same dimension (client resolves the ambiguity, not the composer). An all-empty overlay deletes the key. Alternative — per-dimension keys or a dedicated table — rejected: one read at composition, one write on adjust, nothing to normalize across rows.

### D2 — Composition order: overlay is the last layer, additions pull from the pre-focus map

MCP (`writeMcpPatch`): keep a reference to the server map **after** availability/group/credential filtering but **before** the focus keep-set drops names; then focus; then overlay — `add` restores entries from the saved map by name (a disabled or credential-less server is simply not in it, which is the enabled-universe rule for free), `remove` deletes from the final set. This order makes "addition cannot resurrect a disabled server" structural rather than a check. Skills (`writeSkillsPatch`): effective skill list = (declared set ∪ whole-pack set when undeclared) with overlay add/remove applied, intersected with materialized directories at root-build time; the persona root is built whenever an overlay exists for the preset (including undeclared personas — the forced-root path), else today's path unchanged. Alternative — applying overlay before focus — rejected: additions would be dropped by the keep-set, and the add/remove rules would need two special cases.

### D3 — API on the serialized mutation path

`GET /api/agent/overlay?preset=<id>` returns the stored diff plus the computable universes (addable servers = enabled/visible installed set; addable skills = locally available skill names); `PUT` the diff. Authenticated users only (deployment-global roster semantics, decision from the program). PUT follows the existing runtime-mutation path: reject while a turn streams (the `set_preset` guard), wait-for-idle, rewrite both patches, broadcast picker refresh — same sequence a preset switch rides. Effect lands next session.

### D4 — Panel: compose the view from existing sources

The web picker's role detail gains a 资源微调 section: effective set (derived from the catalog's `resourceSummary` + the two universes from D3's GET), per-item remove toggles, add chip-pickers. No new server-side aggregation endpoint — the GET in D3 is the single source. Applying calls PUT and shows the next-session note.

### D5 — Probe and observability

Extend `scripts/probe-pack-scope.mjs` with a `--overlay` pass: same per-persona report, composed with each role's stored overlay, printed as derived ± overlay. Composition logs name the layer (`focused on … +overlay[add:…,remove:…]`) so drift is greppable.

## Risks / Trade-offs

- [Composition-order bug resurrects an unavailable server] → The structural fix (additions restore from the pre-focus map) is unit-tested directly: disabled, group-gated, and credential-less servers must stay absent.
- [Forced compose root for undeclared personas is a new path] → Byte-diff test: no overlay ⇒ patch bytes equal the pre-change writer output; with overlay ⇒ root contents enumerated in the e2e.
- [Dangling entries accumulate silently] → Accepted (ADR-0001): inert entries cost one set-membership check; a warn-level log on compose names them; no GC in v1.
- [Two clients adjust concurrently] → PUTs serialize on the existing mutation path; last write wins per preset (deployment-global semantics, documented).
- [MP users cannot adjust] → Documented fast-follow; MP keeps the read-only badge from ①.

## Migration Plan

1. Depends on add-persona-resource-sets being live (resolvePersona, compose-root builder).
2. Land storage + composition (no UI): overlays settable via API, e2e green; no behavior change without a stored overlay (byte-diff verified).
3. Land the panel; probe pass; deploy notes document deployment-global semantics.
4. Rollback: revert the deploy tag; stored preference rows are ignored by the previous derivation (additive data), deletable later without ceremony.
