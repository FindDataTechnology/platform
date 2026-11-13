## Context

See `proposal.md` — Why. Implementation-relevant state:

- `lib/pack-manifest.js` `validateProvenance` rejects unknown provenance keys via `PROVENANCE_KEYS` whitelist; kinds are pinned to the existing three (`official-original` / `official-adopted` / `community`). `lib/pack-provenance.js` synthesizes the three axes with the roster-only official invariant ("只合成、不重新推导").
- No fork/clone affordance exists today (verified: no fork/remix in packs surfaces).
- facet already reuses 壹座 market components verbatim; Logto SSO across both domains is in production (facet 直连登录同一租户).
- `add-agent-studio` defines the working document (ephemeral client state, emit = persist); `add-agent-spec-sheet` owns the shared presentation.

## Goals / Non-Goals

**Goals:**
- One fork action, seeded from readable manifests, landing as an editable working document.
- Lineage that is stamped, validated, displayed, and survives republish.
- Zero drift in official semantics, publish gate, or read gates.

**Non-Goals:**
- Fork graphs/network pages, license re-derivation beyond carrying the upstream license field, changes to the three provenance kinds.

## Decisions

### D1 — `forkOf` is a new optional provenance key; `kind` untouched
Add `forkOf` (`{ packId, version }`) to the validator whitelist with shape validation. A fork stamps `kind` consistent with its authorship (community in practice — a fork's author is not the official roster author), so the three-axis synthesis needs no new state.
- *Why*: extends the existing single validator instead of inventing a parallel lineage store; the synthesis point's invariant (official only from roster) automatically holds.
- *Alternative rejected*: a separate `lineage` top-level block — a second place for source metadata, drifting from provenance.
- *Note*: "lineage survives republish" is a soft expectation (spec says not silently dropped), enforced by convention + publish note, not by forbidding removal.

### D2 — Fork seeds the Studio working document, not a pack draft directly
The fork action materializes a seeded working document in the Agent Studio (client state per studio D1); persisting is the user's emit. The seed is the manifest the caller can read, fetched through the existing read surfaces.
- *Why*: keeps fork out of the write paths entirely; the emit gates do their job.
- *Alternative rejected*: fork → pack draft directly — bypasses the user's chance to edit before anything persists, and couples fork to the drafts store.

### D3 — Permission = read visibility
Fork availability follows exactly the manifest read gates (public packs: any authenticated user; private packs: existing visibility rules). No new permission surface.
- *Why*: fork is a read-derived operation; adding a separate gate would either duplicate or diverge.

### D4 — Lineage display lives in the shared spec sheet
The "forked from" line is a spec-sheet concern (one component, many surfaces). Since `add-agent-spec-sheet` is in-flight, this change coordinates: either the sheet lands first and gains the lineage line via this change's follow-up task, or both archive and the line lands in a small display task here.
- *Why*: presenting lineage outside the shared component would fork the presentation.

### D5 — Cross-domain: deep link only
facet renders the fork affordance as a link to 壹座's studio route with pack identity parameters; the fork write happens after 壹座-side auth, in the user's cell. facet stays write-free for authoring (existing boundary).
- *Why*: one write surface (壹座 cell), matching `INSTALL_IS_A_BASE_SURFACE` discipline.

### D6 — Upstream license carries into the fork
The seeded document preserves the parent's `provenance` license field (and upstreamUrl/revision where present) alongside `forkOf`; the author may change license only by editing it explicitly (publish gate still validates).
- *Why*: silent license dropping on fork would misrepresent redistribution rights; carrying it is the honest default.

## Risks / Trade-offs

- **Fork of evolving parents** (parent vN+1 released after fork) → Mitigation: lineage pins the forked version; a "parent has updates" hint MAY be added later (non-goal now).
- **Provenance whitelist extension is a contract change** → Mitigation: single validator, both gates share it; malformed `forkOf` rejected field-level; fixture tests pin accept/reject.
- **Coordination with two in-flight changes** (spec-sheet, studio) → Mitigation: this change's spec touches neither capability; display lands via D4's coordination note; archive order documented.
- **Facet deep link state** (unsigned viewers) → Mitigation: deep link requires sign-in at 壹座 as today; unsigned viewers get the login-guidance path (existing polish-facet-interactions pattern).

## Migration Plan

- Additive: one optional provenance key + one action + one display line; no data migration.
- Rollback: remove the action/display; manifests already carrying `forkOf` remain valid (optional key), so no rollback hazard.

## Open Questions

- Whether the fork seed should also carry the parent's `guide` — deferred to implementation; default yes (content parity), no spec impact.
