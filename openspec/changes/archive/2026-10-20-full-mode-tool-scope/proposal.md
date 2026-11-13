## Why

Tool allowlists only apply in focused mode. `writeMcpPatch` writes the filter as `writeToolFilterPatch(scope.source === "pack" ? scope.mcpTools : null)` — every other composition writes `null`, i.e. no filtering at all. Because `installMcpRef` installs a pack's MCP servers into the cell globally (`enabled: true`), those servers' entire surfaces follow the user into every ordinary chat: a cell with three wire packs installed mounts 387 tools ≈ 139k schema tokens before the first word of the conversation. Custom presets are the same hole from the other side — `deriveScope` hard-codes `mcpTools: null` for `source: "custom"`.

## What Changes

- **Full mode derives a tool scope too.** For every server referenced by an installed pack, full mode applies the union of those packs' declared allowlists for that server. Servers not referenced by any installed pack (the user's own MCP servers, the operator baseline) keep their full surface unchanged.
- **Per-server override.** 设置 → MCP gains a "完整工具面" toggle per server. Turning it on restores the full surface for that server in every mode; the choice persists and outranks the derived union.
- **Custom presets gain a tool dimension.** A custom preset MAY declare `mcpTools` per server, narrowing what its focused sessions expose; absent means the preset inherits the full-mode union rather than the whole surface.
- **Derivation stays a pure function.** The union is computed from the installed pack manifests at every composition, never persisted as a materialized set — same discipline as the existing focus derivation, so a pack upgrade or uninstall re-derives automatically.
- **BREAKING (behavioral).** Full mode no longer guarantees the complete tool surface of a server that an installed pack references. The override toggle and the pack detail's declared-tool counts are the documented escape hatch; a server referenced by no pack is unaffected.

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-agent-scoping`: full mode's resource scope gains a tool dimension (union of installed packs' allowlists, per-server override), replacing the current "no filter in full mode" composition.
- `custom-presets`: custom presets gain an optional `mcpTools` resource dimension and inherit the full-mode union when they declare none.

## Impact

- `dsh-profile.js` — `deriveScope` (full-mode branch, custom branch), `writeMcpPatch` (write the union instead of `null`), `writeToolFilterPatch` call site
- `db.js` / overlay storage — per-server full-surface override (shape to be decided in design; likely an `extension_configs.permissions` key or a dedicated settings row)
- `web/` — 设置 → MCP toggle, plus the pack detail's declared-vs-full tool counts (consumes the existing catalog `tool_list`)
- `agent-runner/compose.js` — inherits through the shared profile pipeline (web cell, desktop, 萬星 runner)
- `scripts/probe-pack-scope.mjs` — acceptance: full-mode roster and `--turn-trace` token delta before/after
- No bridge execution-logic change: the existing `platform-tool-scope.js` bridge already consumes `tool-filter.json` in every mode; its only edit is the denial copy's pointer to the Settings → MCP toggle (product-approved)
