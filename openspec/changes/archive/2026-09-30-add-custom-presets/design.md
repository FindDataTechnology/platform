# Design: add-custom-presets

## Context

Post ①② the machinery this change rides exists: `resolvePersona` maps a preset id through the merged catalog to a source (pack persona today), persona compose roots build from DB rows, generated presets serve catalog `chat` entries through the preset bridge, and the overlay pipeline composes per preset id. The catalog merges four sources with precedence built-in → registry → packs → `agents.json` → cloud; pack-persona entries serialize `packId` + `resourceSummary`. See proposal.md for motivation, ADR-0003 for the cell-local boundary.

## Goals / Non-Goals

**Goals:**

- A custom preset is a third first-class preset family — one derivation function, one badge, one switch path; no parallel pipeline.
- Composition-time truth: references intersect with what the cell actually has; nothing to repair when packs come and go.
- The `user.` namespace makes id collisions structurally impossible going forward; the backstop covers history.

**Non-Goals:**

- Publishing/sharing custom presets (pack-draft export is a future capability); per-user rosters (deployment-global ceiling); MP UI (fast-follow); pack manifest changes beyond the prefix rule.

## Decisions

### D1 — Storage: a `user_presets` table, not a preferences blob

Row: `id` (PK, `user.<slug>`), `name`, `persona`, `skills` (JSON array), `mcpServers` (JSON array), `tags`, `icon`, timestamps. Id assignment: slug from the display name + uniqueness suffix, always under `user.`. Alternative — one preferences JSON roster — rejected: CRUD + catalog-source listing want indexed rows, and the installed-packs table is the working precedent. No `originPackId`-style ownership bookkeeping: the row IS the owner.

### D2 — Catalog: fifth source, precedence between packs and operator file

`catalog.js` gains the user source after packs, before `agents.json` (built-in → registry → packs → **user presets** → `agents.json` → cloud): end-user compositions outrank market packs but stay beneath the operator's file and the cloud control plane — the same "local overrides remote, cloud stays supreme" reading the pack source established. Entries serialize `customPreset: true` + the same `resourceSummary` shape ① defined. Shadowing falls out for free: an overriding id composes full mode under the overriding entry's persona (deriveScope only treats unshadowed custom entries as custom presets — the same merged-catalog honesty rule packs follow). Refresh rides the existing catalog-changed path (preset regeneration + idle restart).

### D3 — Derivation: third family in `resolvePersona`/`deriveScope`

`resolvePersona` returns `{ source: "pack" | "custom", ... }`: pack entries resolve against the installed-pack manifest (①), custom entries against the `user_presets` row. `mcpKeep` = declared refs; `skillsDir` = `custom-skills/presets/<id>/` compose root (same builder as ①, symlinks to materialized dirs wherever they live — user root or pack roots; the DB rows behind those dirs are the availability truth). The ② overlay applies untouched — it is keyed by preset id and composes after derivation. Persona-only enforcement mirrors the pack validator: the CRUD route rejects endpoint/model/credential-shaped fields.

### D4 — API on the serialized mutation path

`GET/POST/PUT/DELETE /api/agent/presets` (+ per-preset GET), authenticated; every mutation fires the catalog-changed refresh (regenerate presets, idle restart, broadcast), rejecting while a turn streams — the same sequence pack install rides. Delete of the selected preset resets the selection to the built-in agent (the stale-selection self-heal already in `server.js`).

### D5 — Web surface

A 自建预设 management page (list/create/edit/delete) with the ① editor's affordances reused: persona textarea + cost readout, skill chips from locally-available skills, server chips from the enabled set. Picker badge 「聚焦·自建」N 技能 · M MCP. MP keeps the read-only view (fast-follow).

### D6 — Prefix rule and backstop

`validatePackManifest` rejects agent ids under `user.` (shared validator → gateway publish + cell install in one edit). `pack-store.js`'s `agentOwner` additionally scans `user_presets` ids and reports the custom preset as the owner on skip — the one-directional policy, one more owner type.

## Risks / Trade-offs

- [Cross-pack skill references die silently on uninstall] → By design (composition-time truth, spec'd as lifecycle-following); the management page shows a "currently unavailable" marker per reference so the state is visible without a probe.
- [Shared-cell roster edits by any authenticated user] → Accepted (decision from the program; matches global preset selection); deploy notes document it.
- [Cloud/operator shadowing of `user.*` ids surprises the author] → Same semantics as packs, surfaced in the management page via the catalog's merged view ("被覆盖" marker).
- [Generated-preset pruning races a live session on the preset] → Rides the existing idle-restart serialization; delete-while-streaming is rejected outright.

## Migration Plan

1. Depends on ① and ② being live (resolvePersona families, compose roots, overlay).
2. Land table + catalog source + derivation (presets selectable via API), e2e green; no behavior change for existing presets.
3. Land management page + badge; prefix rule and backstop; probe treats custom presets as focused roles.
4. Rollback: revert the deploy tag; `user_presets` rows are inert additive data (previous derivation never reads them); no data migration to undo.
