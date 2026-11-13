# Proposal: add-save-to-library-tool

## Why

The model has no way to save a file into the resource library: the only model-visible platform tool is `chart_bind`, and the save API (`POST /api/resources`) demands session credentials the agent child does not hold. Files produced inside scripts — the produced-file rule's biggest blind spot (a `python3` run that writes a csv/pdf is invisible to it) — therefore never reach the library unless the user notices the chat affordance and saves by hand. Asking the model to "put this in 成果" fails outright.

## What Changes

- A model-visible tool `save_to_library` saves workspace files into the library during the turn:
  - parameter is a list of workspace paths (relative or absolute), capped at 10 per call; excess paths are refused individually with a reason;
  - the title defaults to the file name; directories are refused with a reason;
  - saving is immediate — no user confirmation gate (the user's conversational request is the confirmation).
- The tool posts over the cell's loopback bridge to a new `POST /api/resources/save-declared` route — the fourth loopback-only bridge alongside cron / chart-bind / delegation — attributed to the current turn's session (session-level provenance; message id not backfilled).
- The route reuses the existing store gate unchanged: workspace containment (lexical + realpath), per-resource size cap, sha256 dedupe. Per-path results return to the model: `saved` / `already-saved` / `refused` with reason, so it can report to the user.
- The artifact contract gains one clause: every file the model delivers by markdown link should be ensured in the library via the tool — repeated calls are harmless (content dedupe). Automatic capture stays as the fallback for turns where the model does not call.
- No feature flag: route and bridge ship together in one image (the `chart_bind` precedent).

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `resource-library`: files gain a third entry channel — the model's explicit save: the existing save-path requirement's opening is reworded to name both explicit channels (user action, model tool) sharing one gate, and a new requirement covers the tool contract and its loopback-only route.
- `artifact-contract`: the contract content requirement additionally instructs the model to ensure delivered files are ingested via the save tool.

## Impact

- `dsh-profile-template/` — new save-library bridge plugin (pattern: `platform-chart-bind-bridge.js`), wired through `dsh-profile.js` skills/plugins composition.
- `server/auth.js` — fourth loopback-only bridge predicate (`save-declared`).
- `server/routes/resources.js` — `POST /api/resources/save-declared` handler; `resources.js` — reuse `storeFileCopy`, new `source` value for model saves.
- `skills/platform-output-contract/SKILL.md` — one delivery-ingest clause.
- Out of scope: mirror paths that record assistant turns without blocks (worker pool / remote forks — separate change), produced-file rule expansion, chart ingest via tool, library UI changes.
