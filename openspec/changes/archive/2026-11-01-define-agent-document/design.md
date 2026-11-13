## Context

See `proposal.md` — Why. Current state that shapes the approach:

- The content model already exists and is single-sourced: `lib/pack-manifest.js` (`validatePackManifest`) plus `server/fleet-template.js` (`parseFleetTemplate`), with `server/blueprint-validate.js` explicitly delegating to both ("零第二造").
- The same model is wrapped in five nouns and six authoring entries: `CustomPresetsPage` (persona + skill/MCP chips, cell-local), `PackDraftsView` (manual pack form), `PresetPublishFlow` (preset→pack), `BlueprintStudioPage` (boundary/dataSources/fleet/agents/mcp/monitoring/acceptance/board, form+JSON), four in-chat builder personas (`fleet-architect`, `pack-author`, `blueprint-author`, `facade-builder`), and facet `MineView` (manifest direct publish).
- Display is split: `PackMarketView` + `PackDetailDialog`, `AgentsPage` Experts, `AssistantPicker`, and `web/src/lib/packGuides.ts` which hardcodes five official teams' guide copy client-side even though `manifest.guide` already exists.
- Provenance is already synthesized in one place (`lib/pack-provenance.js`), type badge in `lib/pack-badge.js` (structural, author cannot override).
- facet (`谦面`) reuses `PackMarketView` verbatim; no fork/clone affordance exists anywhere.

## Goals / Non-Goals

**Goals:**
- Name and bound the atomic unit (Agent Document) so every future surface references one model instead of inventing a shape.
- Fix the four emit targets and their validation contract so no target can drift.
- Fix the editor/lifecycle boundary so "one editor" cannot be misread as "blueprint is being cut".
- Fix the display contract (three-bucket spec sheet) so market / official / picker cannot render agents differently.

**Non-Goals:**
- The visual builder itself (`add-agent-studio`).
- Guide-content migration (`move-pack-guides-to-manifest`).
- Any lifecycle change, any data-shape change, any code change in this change.

## Decisions

### D1 — Agent Document = the existing pack manifest, named and bounded
Do not introduce a new serialization. The document is the pack manifest; this capability adds naming, the three-bucket framing, and the emit/lifecycle invariants.
- *Alternative rejected*: a separate "agent" schema parallel to pack manifest — would create a second validator and a conversion layer, exactly the drift the single validator avoids.

### D2 — One validator set, four emit targets
Every emit target calls the same `validatePackManifest` + `parseFleetTemplate` (+ tool-face closure gate) at emit time. Emit is defense in depth, not the only gate.
- *Why*: publish and install already re-validate the same manifest; adding targets that trust compose-time state would reopen the "validate once, trust forever" hole.
- *Alternative rejected*: per-target light validators — cheaper but guarantees the surfaces drift, which is the current defect.

### D3 — One editor, four lifecycles (editor ≠ lifecycle)
The editor is allowed to converge; the lifecycles are not. Boundary table:

```
                 preset        pack draft      fleet template     blueprint
                 (cell-local)  (market)        (deploy)           (asset pipeline)
  lifecycle      resident      immutable ver   instantiate        validate->approve->cast->iterate
  gate           none          publish gate    install gate       approval required before cast
  editor         same          same            same               same
```

- *Why*: blueprint's approve/cast/iterate is the platform's asset-iteration loop (fleet-owner-iteration depends on it). Converging editors must not be read as converging that pipeline.
- *Alternative rejected*: fold blueprint into pack only (drop approve/cast) — destroys the iteration loop and the curation audit trail.

### D4 — Three-bucket spec sheet is one shared component
The spec sheet (persona / skills / MCP tool face + badge + provenance + guide) lives in one shared component consumed by market detail, official gallery, and picker; surfaces supply data, never re-layout the buckets.
- *Why*: `PackMarketView` is already reused verbatim by facet; the same discipline must extend to the agent presentation or two markets will render agents differently.
- *Alternative rejected*: per-surface layouts — the current state, and the reason official agents read as opaque cards.

### D5 — Content as data, not code
Guides belong in `manifest.guide` + `i18n` (already supported), not in `packGuides.ts`. Deferred to `move-pack-guides-to-manifest`, but recorded here as the direction so the studio emits guides as data from day one.
- *Why*: one official copy change should not require a client rebuild, and facet must read the same source.

### D6 — Downstream sequencing (each its own change)
```
define-agent-document  (this)
   ├─ move-pack-guides-to-manifest   (small, content-as-data)
   ├─ add-agent-spec-sheet           (display contract realized)
   └─ add-agent-studio               (the visual builder; biggest)
         ├─ fold-blueprint-into-studio   (team mode; lifecycle untouched)
         └─ add-agent-fork-lineage       (clone + fork-of provenance)
               └─ add-official-agent-gallery  (official agents as spec sheets + fork)
```
Order rationale: land the cheap display/data wins first (they make the model legible), then the builder, then fork, then official gallery (which dogfoods the builder).

### D7 — In-chat builder personas are tool faces, not deleted
The four builder personas stay available in chat; in the studio they become "AI draft" actions writing into the canvas. AI produces drafts; humans approve.
- *Alternative rejected*: delete personas and keep only the canvas — loses the conversational authoring path and violates the "AI proposes, gate approves" discipline's spirit.

## Risks / Trade-offs

- **Canvas cost cliff** — a writable team graph is far heavier than three-bucket cards. Mitigation: v1 = writable three-bucket cards + read-only team graph (reuse `FleetGraph`); writable graph is a follow-up, not in `add-agent-studio` v1.
- **"Cut blueprint" misread** — merging editors invites the reading that blueprint is being removed. Mitigation: D3 invariant + explicit Non-goal + spec requirement "Editor convergence SHALL NOT converge lifecycles".
- **Official seed regression** — today official assets are hand-written JSON pinned by `scripts/test-*-seed.mjs`; moving authoring to the studio must keep "manifest is the source of truth + tests pin it". Mitigation: the studio emits the same manifest; seeds stay pinned.
- **Cross-domain fork writes** — fork from facet must land in a 壹座 cell (Logto SSO exists, but write stays cell-side). Mitigation: facet emits a deep link; the write happens in 壹座 after login, preserving the cell-authoring boundary.
- **Two markets, one component** — facet reuses 壹座's market view; a spec-sheet shared component must be importable by both builds. Mitigation: put it in the shared web layer both already consume.

## Migration Plan

- This change is spec-only: no code, no data migration, no rollback surface.
- Archive adds `openspec/specs/agent-document/spec.md`.
- Downstream changes each carry their own migration/rollback.

## Open Questions

- Writable team graph timing: v1 read-only (default) vs writable — deferred to `add-agent-studio` scoping; does not change this spec.
- Whether the studio is reachable from facet via a read-only preview mode — deferred to `add-agent-spec-sheet` / `add-agent-fork-lineage`.
