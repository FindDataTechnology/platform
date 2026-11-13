## Why

The manifest already supports `allowTools`, and publish already validates the names it contains — but a reference that declares nothing is accepted silently and mounts the server's entire tool surface. That is the state of 33 of the 34 packs in the authoring repo. The enforcement half exists; the gate that would have forced a decision never did. Measured cost of the silence: `wire-ic-debate` mounts 255 tools (~92k schema tokens) while its skills name 11.

## What Changes

- **Every MCP reference carries an explicit tool face.** A publish fails unless each reference declares a non-empty `allowTools` list or carries `fullSurface: true` with a non-empty reason. "No declaration" stops being a legal published state.
- **Tool-level closure at publish.** Every `mcp__<server>__<tool>` named in the pack's skill bodies must fall inside that reference's declaration; a `fullSurface` reference is exempt (its face is the whole surface by definition).
- **The existing name validation is preserved and folded in**: registry-snapshot existence, live-probe staleness fallback, unresolved-not-absent probe failures, commercial-surface closure, and the local-binding exemption all keep their current semantics.
- **The full-surface reason is disclosed.** The pack detail view shows, per MCP reference, the declared tool count against the server's catalog tool count — and for a `fullSurface` reference, the author's reason.
- **Legacy manifests stay installable.** The gate is publish-time only: already-installed versions with no declaration keep working, and the runtime treats their absent declaration as the full surface.

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-authoring`: MCP references gain an explicit tool-face requirement (allowlist or reasoned full-surface marker); the publish validation requirement is replaced by one that additionally enforces tool-level closure.
- `pack-marketplace`: the pack detail view discloses each MCP reference's declared tool face and the full-surface reason.

## Impact

- `lib/pack-manifest.js` — accept `fullSurface` / `fullSurfaceReason` (mutually exclusive with `allowTools`), reject neither-declared at publish
- `facet/` publish path — tool-level closure against skill bodies, alongside the existing snapshot/probe/commercial checks
- `registry-bridge.js` / market catalog — `tool_list` already carried; the detail view consumes it for the declared-vs-total display
- `web/` — pack detail tool-face disclosure; the draft editor's "no tools selected" state gains the full-surface marker with a reason field
- No runtime change (that is `full-mode-tool-scope`); no registry change
