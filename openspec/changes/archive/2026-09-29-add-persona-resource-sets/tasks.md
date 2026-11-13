# Tasks: add-persona-resource-sets

## 1. Groundwork — deriveScope two-stage refactor (D1, inert)

- [x] 1.1 Split `deriveScope` in `dsh-profile.js` into `resolvePersona(presetId)` (catalog entry → installed pack + agent entry) and `deriveScope(presetId)` (persona → effective set), keeping behavior identical; verify by running the existing `e2e/pack-agent-scoping.spec.js` green and diffing the written patch bytes on the dev cell before/after (must be equal)
- [x] 1.2 Export `resolvePersona` for the follow-up changes and add a unit test asserting preset-id → {packId, agentId} resolution including the shadowing case (an id overridden by cloud/agents.json entries resolves to no persona)

## 2. Manifest schema + shared validation (D2)

- [x] 2.1 Extend `validatePackManifest` in `lib/pack-manifest.js` with `agents[i].resources = { skills?, mcpServers? }`: subset-of-own-lists, no duplicates, unknown names rejected naming the role; verify with new unit tests covering foreign name, duplicate name, and valid mixed-dimension declarations
- [x] 2.2 Add dimension-independence cases to the validator tests (absent dimension = whole-pack, present-but-empty = none) and verify `pack-store.js` install path rejects an invalid declaration manifest with status 400 (existing install re-validation route)

## 3. Runtime composition (D3, D4)

- [x] 3.1 Add persona compose-root builder to `skill-materialize.js`: `packs/<packId>/personas/<agentId>/<skillName>` → relative symlinks, built idempotently from DB rows, skipped when declaration absent/empty; verify with a unit test that rebuilding twice yields identical trees and that uninstalling the pack removes `personas/` wholesale
- [x] 3.2 Apply declaration semantics in `deriveScope`: `mcpKeep = packRefs ∩ declared` (undeclared → `packRefs`), `skillsDir` = persona root when `resources.skills` is present (empty → null), pack root when absent; verify via the `[dsh-profile] focused on pack …` log line naming the persona and kept set
- [x] 3.3 Extend `writeSkillsPatch` to list the persona root in focused mode; verify a dev-cell boot under a declared persona yields a skills patch listing baseline + persona root only, and under an undeclared persona the pack root (byte-equal to pre-change)

## 4. Web UI — picker badge + editor (D5, D6)

- [x] 4.1 Serialize `resourceSummary: { skillCount, mcpCount, declared }` on pack-sourced entries in `catalog.js`, computed from the installed manifest; verify `GET /api/catalog` shows per-role counts for a declared pack and pack-level counts for an undeclared one
- [x] 4.2 Picker badge shows 「聚焦·<pack>」+ N 技能 · M MCP; verify in the web picker against a multi-agent pack that undeclared roles show pack counts and declared roles show their own
- [x] 4.3 Pack editor: per-role resource accordion with chip pickers sourced from the draft's own skill/MCP lists (no free-form entry), persisted into the draft; verify a draft with a mixed-dimension declaration round-trips through save/reload
- [x] 4.4 Persona cost readout in the editor (char count + ≈tokens/turn heuristic note); verify it updates live while editing persona text

## 5. Probe (D7)

- [x] 5.1 Extend `scripts/probe-pack-scope.mjs` to report per persona: effective server/tool counts and traced token delta vs full mode; verify a local run against a cell with a multi-agent pack prints one full roster plus one focused block per persona

## 6. E2E + seed packs (D8)

- [x] 6.1 Extend `e2e/pack-agent-scoping.spec.js`: declared-subset focus (MCP counts in the patch), undeclared default (patch bytes unchanged), empty declaration (baseline only), upgrade re-derives on declaration change; verify the suite passes 7/7 → new total green
- [x] 6.2 Republish the 4 gateway seed packs with declarations (at least one mixed-dimension, one empty) as next versions; verify each upgrade on the dev cell via the install report and probe output
- [x] 6.3 Deploy to fd-prod via the Jenkins `platform` job + GitOps tag bump; verify the probe on prod records per-persona numbers within the 20–40 tool band and the numbers land in the deploy notes
