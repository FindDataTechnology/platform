## Context

See `proposal.md` — Why. Implementation-relevant state:

- Current presentation is scattered: `PackDetailDialog.tsx` (1094 lines, renders full skill bodies + personas + MCP refs + deployment panels), `AssistantPicker.tsx` (agent rows carry name + focus badges), `web/src/lib/packGuides.ts` (hardcoded guide copy by pack id), official showcase (badge only).
- The derivations already exist and must not be reimplemented: `lib/pack-badge.js` (`deriveBadge` / `badgeFromFlags`), `lib/pack-provenance.js` (`describeProvenance`, three-axis synthesis with the roster-only official invariant).
- facet reuses `web/src/components/packs/PackMarketView.tsx` and `PackDetailDialog` verbatim; the shared web layer (`@platform/core` / shared components) is imported by both builds.
- `manifest.guide` already exists in the validator (`PACK_LIMITS.maxGuideStepTitleChars/BodyChars`), so rendering it is a data read, not new content.

## Goals / Non-Goals

**Goals:**
- One spec-sheet component + one presentation contract, consumed by market detail, picker, studio preview, and (later) official gallery.
- Bucket rendering, badge, provenance, and guide all sourced from existing derivations/data.
- 壹座 and facet render identically by construction.

**Non-Goals:**
- Data-shape changes, new derivations, clone/lineage, guide-content migration, official-gallery curation.

## Decisions

### D1 — Component lives in the shared web layer
Put the spec sheet where both 壹座 and facet already import shared components (the same layer `PackMarketView` lives in), so the two builds cannot drift.
- *Why*: facet already reuses 壹座's market components verbatim; keeping the sheet there makes parity structural, not a test to remember.
- *Alternative rejected*: per-app copies — the drift we are eliminating.

### D2 — Consume existing derivations; do not re-derive
Badge comes from `deriveBadge`/`badgeFromFlags`; provenance from `describeProvenance`. The component is a pure renderer of already-derived values.
- *Why*: single synthesis point is an existing invariant (provenance module comment: "只合成、不重新推导"); re-deriving in the sheet would fork it.
- *Alternative rejected*: component-local badge/provenance logic — violates the single-synthesis invariant.

### D3 — Buckets are sections, not tabs; empty is explicit
The three buckets render as ordered sections on one sheet; an empty bucket renders a visible empty state. Full-text expansion is per-item, not a separate route.
- *Why*: tabs would hide two buckets at a time, defeating "three buckets as one unit"; explicit empty states prevent the "is it missing or empty?" ambiguity.
- *Alternative rejected*: tabbed layout — breaks the atomic-unit display invariant.

### D4 — Guide is data-driven with omission
Render `manifest.guide` when present; render nothing when absent. Do not fall back to `packGuides.ts` copy inside the component.
- *Why*: the component must be content-agnostic; the migration of legacy hardcoded guides is a separate change.
- *Trade-off*: until `move-pack-guides-to-manifest` lands, packs whose guide lives only in `packGuides.ts` will show no guide block in the sheet. Mitigation: that change backfills `manifest.guide` for the official set.

### D5 — Market detail keeps expandable bodies
`PackDetailDialog`'s full skill bodies and persona full text remain available, but inside the shared sheet's per-item expansion, not a bespoke layout.
- *Why*: the inspect-before-subscribe capability must not regress.
- *Alternative rejected*: summary-only sheet — loses the pre-subscription inspection guarantee.

### D6 — Picker consumes a compact mode of the same component
The conversation picker renders the same component in a compact mode (buckets collapsed to one-line counts + badge), not a separate renderer.
- *Why*: one component, two densities; a separate picker renderer reintroduces drift.
- *Alternative rejected*: picker-specific component.

## Risks / Trade-offs

- **Guide gap until migration** → Mitigation: `move-pack-guides-to-manifest` backfills `manifest.guide` for official packs; the sheet shows no guide in the interim rather than inventing copy.
- **PackDetailDialog blast radius** (1094 lines, deployment panels interleaved) → Mitigation: extract the agent-presentation sections into the sheet; leave deployment/facade panels in the dialog as separate blocks.
- **Facet build import path** → Mitigation: place the component in the existing shared layer both builds consume; add a facet build check.
- **i18n chrome parity** → Mitigation: bucket labels/empty states keyed in five locales via the existing parity gate; content stays zh-authoritative.

## Migration Plan

- Additive component + in-place replacement of two consumers (market detail, picker); no schema change.
- Rollback: revert the two consumers to their prior layout; the component is new and unused then.
- Downstream: `add-agent-studio` (preview pane) and `add-official-agent-gallery` consume it after landing.

## Open Questions

- Whether provenance/badge should be computed server-side and shipped pre-derived (preferred for parity) or derived client-side from the same modules — deferred to implementation; either path uses the same rules.
