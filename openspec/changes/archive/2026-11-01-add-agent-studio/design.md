## Context

See `proposal.md` — Why, and `define-agent-document` for the model/invariants. Implementation-relevant state:

- Existing reuse targets: `FleetGraph.tsx` / `FleetCanvas.tsx` (read-only graph rendering), `packs-api.ts` (draft/validate/publish), `presets-api.ts` (cell-local presets), `useExtensionsStore` (skills/MCP catalogs), `AssistantPicker` (roster metadata), `PackDetailDialog` (the current "inspect" layout that a spec sheet will supersede).
- Single validator lives server-side: `validatePackManifest` (`lib/pack-manifest.js`), `parseFleetTemplate` (`server/fleet-template.js`), `toolFaceErrors`/`toolClosureErrors` (`lib/publish-tool-gate.js`). `server/blueprint-validate.js` already composes them — a working precedent for a "compose-time validation" endpoint.
- Authoring persistence today: pack drafts (cell store), custom presets (cell store), blueprints (`blueprints.db`). No "studio document" store exists.
- The four in-chat builder personas already have loopback tool bridges (`fleet-architect-mcp.js`, `blueprint-author-mcp.js`, pack-author tool face) — AI drafting is a call away, not a new subsystem.

## Goals / Non-Goals

**Goals:**
- One surface that renders and edits the three buckets as a unit, with a read-only team graph.
- Compose-time validation through the existing validators, and emit-time re-validation.
- Emit to preset + pack draft without new persistence or new validators.

**Non-Goals:**
- Writable team graph, live chat preview, blueprint/template emit targets, fork/lineage, guide-content migration.
- Removing or disabling the six existing authoring entries (a later change folds them).

## Decisions

### D1 — Working document is ephemeral client state; persistence is the emit
The studio holds the Agent Document in client state while composing. There is no new "studio document" table. Persisting means emitting: a preset write or a pack-draft write into the existing cell stores.
- *Why*: avoids a second store and migration; matches `BlueprintStudioPage`'s "draft zero side-effects" discipline.
- *Alternative rejected*: new `studio.db` — a second source of truth, migration cost, and a fourth lifecycle nobody asked for.
- *Trade-off*: a long multi-agent composition isn't resumable until emitted; acceptable for v1, and the pack-draft emit gives a save point.

### D2 — Compose-time validation reuses the existing publish-gate dry-run endpoint
**Amendment (2026-10-31, 实施期发现)**: the planned thin endpoint already exists — `POST /api/packs/validate` (creator-pack-forge-support) runs the exact publish gate sequence (`collectPublishVerdict`: structural → attribution → tool-face → fleet-template → files), reports every gate's reject body verbatim, accepts any authenticated caller (eligibility is a caller finding), and has its own rate limiter. The studio consumes it debounced; **zero new server code, zero new endpoint**. A test pins the contract (scripts/test-agent-studio-validate.mjs: structural errors === lib validator output; fleetTemplate stage === parseFleetTemplate errors; toolFace stage in enforce mode).
- *Why*: the client must show the same errors the emit will produce; reusing the collector guarantees it by construction ("one collector, so the two faces can never drift").
- *Original plan* (add a thin endpoint copying blueprint-validate) superseded — that shape would have duplicated an existing, better-scoped route.

### D3 — Three-bucket card is new; the spec sheet is shared and dependency-ordered
The canvas card is a new component (editable). The right-pane structural preview SHOULD be the shared spec sheet owned by `add-agent-spec-sheet`. If the spec-sheet change has not landed, the studio ships a minimal inline preview (persona summary + skill list + MCP refs) and converges to the shared component later.
- *Why*: market/detail/official/picker must render agents identically; one component, many consumers.
- *Alternative rejected*: studio-specific preview layout — guarantees two renderings of the same agent.

### D4 — Team graph reuses FleetGraph read-only
The team canvas renders through the existing `FleetGraph`/`FleetCanvas` in read-only mode; membership edits happen on the cards/roster and re-render the graph.
- *Why*: the graph engine, layout, and node semantics already exist and are proven in the cockpit.
- *Alternative rejected*: a new graph library — new layout semantics, new bugs, no payoff.

### D5 — AI drafting reuses existing tool bridges
AI draft actions call the existing builder tool faces (architect/author) through their current loopback bridges/endpoints; the result is applied to the working document as a draft. No new write path, no new tool surface.
- *Why*: preserves "AI proposes, gate approves"; avoids a parallel authoring backend.
- *Alternative rejected*: studio-specific generation service — a second write path and a second place to keep honest.

### D6 — Emit is a two-step, re-validated action
Emit always runs the same validator first, then writes through the existing endpoint: preset via `presets-api` create; pack draft via `packs-api` draft create (which later enters the publish gate). The working document is not mutated by emit.
- *Why*: emit-time validation is defense in depth; publish gate/immutability stay untouched.
- *Alternative rejected*: trusting the last compose-time validation — reopens "validate once, trust forever".

### D7 — v1 preview is structural, not a live turn
The preview pane shows the rendered spec sheet + validation + provenance + locale status. A live chat preview (actually running the agent) is out of scope for v1; after emitting a preset/draft the user can open the conversation with that agent.
- *Why*: live execution needs a runtime bind, cost, and streaming plumbing; it is a separate capability, not a builder prerequisite.
- *Alternative rejected*: embed a chat turn in the studio — scope explosion and runtime coupling.

### D8 — Studio is additive; existing entries stay until a fold change
Studio is a new route/surface. The six existing authoring entries remain functional; `fold-blueprint-into-studio` later retires the redundant ones.
- *Why*: lets the builder ship without a big-bang migration; users keep working paths.
- *Alternative rejected*: replace all entries in one change — high blast radius, no fallback.

## Risks / Trade-offs

- **Duplication during transition** (studio + old editors) → Mitigation: additive first; fold change retires old paths; shared spec sheet prevents display drift.
- **Validation endpoint parity** → Mitigation: endpoint calls the exact same functions the publish gate calls; a test asserts identical error text for a fixture document.
- **Multi-agent working doc size / UX** → Mitigation: v1 roster + cards; graph read-only; cap working-doc agents at the manifest's existing agent limit.
- **i18n parity gate** → Mitigation: all new chrome keyed in five locales; content stays zh-authoritative per existing policy.
- **Creator gate confusion** (compose is open, publish is gated) → Mitigation: emit-to-draft is allowed for any authenticated user; publish surfaces the existing gate error verbatim.

## Migration Plan

- Additive: new route + new components + one thin validate endpoint; no schema migration.
- Rollback: remove the route/entry point; existing editors untouched, so no user data at risk.
- Downstream: `fold-blueprint-into-studio` (team mode + blueprint emit) depends on this; `add-agent-spec-sheet` may land before or after (D3 fallback).

## Open Questions

- Should in-progress multi-agent documents be resumable before emit? (Deferred; v1 ephemeral, pack-draft emit is the save point. Answering "yes" later adds a persistence task, not a spec change.)
- Should the validate endpoint live under packs or a neutral studio path? (Deferred to implementation; either way it calls the same validators.)
