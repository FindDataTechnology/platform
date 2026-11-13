# Tasks: add-pack-agent-scoping

## 1. Scope derivation

- [x] 1.1 Add a pure `deriveScope(currentPreset)` helper (preset id → catalog entry → packId → installed-pack manifest → { mcpKeep, skillsDirs, packId | null }) in dsh-profile.js; verify with a unit-style self-check run (`node dsh-profile.js`) covering: pack preset, shipped preset, preset whose pack was uninstalled
- [x] 1.2 Thread scope into `writeMcpPatch` (subtractive layer after the personal overlay: keep mcp.json ∪ PACK_BASELINE_MCP ∪ pack registryNames ∩ installed) and `writeSkillsPatch` (root list per mode); verify by inspecting both written patch files under each mode in the self-check

## 2. Pack-scoped skill materialization

- [x] 2.1 Extend skill-materialize.js: pack-owned rows write under `custom-skills/packs/<safePackId>/<skill>/SKILL.md`, user rows keep the flat root; `rebuildFromDb` reconciles both roots (wipes stale flat dirs from before the migration) — verify a boot against a DB with an installed pack re-materializes its skills into the pack root with none left flat
- [x] 2.2 Update pack-store.js install/uninstall to materialize/remove through the pack root; verify install → focused boot → uninstall leaves no orphan dirs

## 3. Runtime wiring

- [x] 3.1 Boot path (server.js initDshAgent): derive scope from the persisted preset before writing patches; verify a boot with a pack preset selected composes focused without user action
- [x] 3.2 Preset switch path (agent-session.js switchPresetToInner / switchAgentToInner): rewrite both patches (scoped writers) then ride the existing `restart({ agentPreset })`; verify pack→standard and standard→pack round-trip restores the full / focused surfaces (probe the written patch files)
- [x] 3.3 MCP CRUD while focused: confirm `dshUpdateMcp` rewrites with scope preserved (add + disable a server while focused; patch stays scoped) and pack install/upgrade hooks re-derive (upgrade adding an MCP ref lands in the focused set after the next composition)

## 4. Visibility

- [x] 4.1 catalog.js: serialize `packId` for pack-sourced entries; `catalogEntryPersona`: append the focus note line for entries with packId — verify via self-check output + `GET /api/catalog` payload
- [x] 4.2 Web picker badge: mark pack agents as focused with pack name (`data-testid` assertion in e2e); verify manually and in e2e

## 5. Measurement & e2e

- [x] 5.1 Probe script (scripts/ or tools/): report full vs focused effective MCP servers + per-server tool counts by parsing the written patches / roster; verify it runs against a local deployment with an installed pack
- [x] 5.2 Turn-tracing comparison: same prompt, same model, both modes; record usage-token delta — verify the numbers land in the change log / decision record
- [x] 5.3 E2e walkthrough: install pack → select its role (badge shows, patch scoped) → ask for an out-of-scope tool (persona declines honestly) → switch back to standard (full surface restored); verify against the dev harness ([::1]:3000 quirks) with the flake baseline in mind
