## Context

See `proposal.md` — Why. Implementation-relevant state:

- `web/src/lib/packGuides.ts` carries per-pack `steps` (three-step guide) and `prompts` (four welcome-state prompt cards), consumed by `PackDetailDialog` (guide card), `ChatWelcome` (prompt cards), and `HelpDialog` (starter-team sequences).
- `manifest.guide` is already validated (`PACK_LIMITS.maxGuideStepTitleChars/BodyChars`, exactly three steps) and `pack-locale-tracks` provides the en overlay contract (`guide.steps` translated as a whole group, 3:1 ratio rule).
- `official-starter-teams` spec already mandates 说明卡与种子 manifest 同源 — this change is the content-side compliance for that requirement, not a spec change there.
- Version immutability: guide edits land by publishing vN+1; there is no in-place edit of a published version.

## Goals / Non-Goals

**Goals:**
- Guide copy lives in the manifest; clients render from data.
- Official set gets en overlays; consuming surfaces switch without behavior change beyond the source of copy.

**Non-Goals:**
- Migrating the four welcome-state prompt cards (chrome suggestions; would extend manifest shape — separate change if wanted).
- Any validator/publish-gate rule change.

## Decisions

### D1 — Backfill via new versions, official first
For each pack whose guide lives only in `packGuides.ts`, author `manifest.guide` from the existing copy verbatim (content parity, no rewrite) and publish vN+1. Official packs additionally get `i18n.en.guide` (whole-group translation per locale-tracks rules).
- *Why*: versions are immutable; a new version is the only write path. Official first because their copy is public-facing and locale-tracked.
- *Alternative rejected*: server-side alias table mapping pack id → copy — keeps a second source of truth, which `official-starter-teams` already forbids.

### D2 — Consumers read pack data, not a client map
`PackDetailDialog` renders the guide from the manifest it already fetches. `ChatWelcome`/`HelpDialog` guide-styled blocks switch to data carried by the catalog/detail payloads they already receive (or omit the block when absent).
- *Why*: one source; surfaces already hold the manifest.
- *Trade-off*: `ChatWelcome`'s guide card for a not-yet-installed expert depends on catalog detail availability; the card is omitted when data lacks a guide rather than falling back to client copy.

### D3 — Prompts stay client-side
The four prompt cards per pack remain in client code: they are conversation starters (chrome), not pack content, and moving them would extend the manifest schema and the publish gate.
- *Alternative rejected*: migrate prompts too — scope creep into manifest shape change.

### D4 — packGuides.ts shrinks, does not vanish
After consumer switchover the file retains only `prompts` (and any chrome-only metadata); the guide-step entries and their pack-id keys are deleted.
- *Why*: deleting outright would break welcome prompts; keeping steps would preserve the second source.

### D5 — Sequencing after `add-agent-spec-sheet`
The spec-sheet change owns the guide-block rendering contract ("guide comes from the document"); this change is its content backfill. Order: spec-sheet first (or same release), then backfill, then consumer switchover completes.

## Risks / Trade-offs

- **Copy drift during migration** (client copy vs published manifest briefly differ) → Mitigation: parity test asserting published manifest guide equals the retired client copy at switchover commit; migration is one batch, not a slow drip.
- **Version noise** (several official packs publish vN+1 in one batch) → Mitigation: single release batch with `notes` stating "guide 迁移，无功能变更"; subscribers see the update badge per existing semantics.
- **3:1 ratio rejections on en translation** → Mitigation: existing locale-tracks rules; translations authored to pass the publish gate (length-ratio failures are caught at publish, before anything is stored).
- **Welcome guide card regression** → Mitigation: ChatWelcome tests pin the omission behavior for guide-less packs.

## Migration Plan

1. Land spec-sheet guide contract (if not already).
2. Author + publish new manifest versions with guides (official first, then community packs whose copy exists).
3. Switch the three consumers to data-driven rendering; delete guide entries from `packGuides.ts`.
4. Locale parity gate + walkthrough.
- Rollback: consumers revert to the prior rendering; published manifest versions are additive and harmless if left in place.

## Open Questions

- Whether any community (non-official) pack guides exist beyond the official set in `packGuides.ts` — resolved by inventory at apply time; the change covers whatever the inventory finds.
