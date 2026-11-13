# Tasks: add-custom-presets

## 1. Storage + id assignment (D1)

- [x] 1.1 Add the `user_presets` table and CRUD helpers in `db.js` (id/name/persona/skills/mcpServers/tags/icon/timestamps); verify with a unit test round-tripping a row and asserting the `user.` prefix on server-assigned ids including slug-collision suffixing

## 2. Catalog source + derivation (D2, D3)

- [x] 2.1 Add the user source to `catalog.js` (fifth source, precedence packs → user presets → `agents.json`; entries persona-only with `customPreset: true` + `resourceSummary`); verify `GET /api/catalog` serves a created preset, and a same-id `agents.json` entry shadows it (merged view shows the override)
- [x] 2.2 Extend `resolvePersona`/`deriveScope` in `dsh-profile.js` with the `custom` family (row → `mcpKeep`/skills refs; compose root `custom-skills/presets/<id>/`); verify a focused boot under a custom preset lists baseline + its root only, and a shadowed id composes full
- [x] 2.3 Verify the ② overlay composes for custom presets (stored overlay adjusts the custom role's set on next composition; disabled-server and dangling-entry rules hold) in a unit test mirroring the pack-role overlay tests

## 3. Validator + backstop (D6)

- [x] 3.1 Reject agent ids under `user.` in `validatePackManifest` (shared validator); verify a publish and an install attempt with a `user.`-prefixed agent id both fail naming the reserved namespace
- [x] 3.2 Extend `agentOwner` in `pack-store.js` to scan `user_presets`; verify a pack install meeting a custom preset's id skips that agent and the report names the custom preset as owner, leaving the preset untouched

## 4. API + web (D4, D5)

- [x] 4.1 Add `GET/POST/PUT/DELETE /api/agent/presets` in `server.js` on the serialized mutation path (catalog refresh, idle restart, broadcast; reject while streaming; delete of the selected preset resets to the built-in agent); verify each mutation's effect and the mid-stream rejection
- [x] 4.2 自建预设 management page: list (with unavailable-reference and shadowed markers), create/edit form reusing the persona cost readout + skill/server chips, delete with stale-selection reset; verify a create→select→edit→delete round-trip in the web UI
- [x] 4.3 Picker badge 「聚焦·自建」N 技能 · M MCP for custom presets; verify the badge renders with correct counts and the focus note lands in the generated persona text

## 5. Probe, e2e, deploy (D5 probe, design)

- [x] 5.1 Extend `scripts/probe-pack-scope.mjs` to treat custom presets as focused roles (per-preset report); verify a local run prints a custom preset's server/tool counts and token delta
- [x] 5.2 New e2e `e2e/custom-presets.spec.js`: create/select/focus/edit/delete-reset, cross-pack skill lifecycle (uninstall drops, reinstall returns), shadowed id runs full, pack-install backstop skip; verify green alongside the existing suites
- [x] 5.3 Deploy after ①② are live; verify probe on fd-prod, record deployment-global roster semantics + MP fast-follow note in the deploy notes
