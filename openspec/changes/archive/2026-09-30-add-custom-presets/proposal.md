# Proposal: add-custom-presets

## Why

Focused roles today come from exactly one place: packs someone else published. A subscriber who wants "the legal pack's contract-review skill + the open-data MCP + my own persona text" has no way to compose that role — the pieces exist in the cell, the assembly doesn't. This is the 「造」 half of the program's user-side decision: let any authenticated user build a persona preset from locally-available resources, focused by construction, without waiting for a pack author. It stays cell-local by design (ADR-0003): sharing goes through the marketplace's pack path, never a local preset's publish backdoor.

## What Changes

- Authenticated users can **create, edit, and delete custom presets** in the cell: display name, persona text (with the cost readout), optional tags/icon, and resource references — any locally-available skills (own or any installed pack's) and any installed servers. Persona-only, exactly like pack agents: no endpoint, model, or credential fields exist.
- Custom presets are **focused by construction**: selecting one composes the deployment baseline plus its declared resources (intersected with what is actually available at composition — a referenced pack skill leaves when its pack uninstalls and returns on reinstall), with the overlay (add-focus-overlay) applying after, since it is a focused role like any other.
- They enter the agent picker as a **fifth catalog source** (DB rows → persona-only entries with a focus badge and resource summary), riding the existing generated-preset machinery; ids are server-assigned under the reserved `user.` prefix; deleting a preset prunes its generated preset and resets a stale selection, exactly as unsubscribing a pack does.
- **Id isolation is double-locked**: pack manifests may no longer declare agent ids under `user.` (shared validator, gateway + cell), and a pack install that still meets a custom preset's id skips that agent with a reported reason — the marketplace's existing one-directional foreign-content policy extended to treat custom presets as owners.
- Web gains a **自建预设 management page** (list / create / edit / delete) and the picker badge 「聚焦·自建」; MP parity is a fast-follow.

Non-goals: publishing or sharing custom presets (marketplace round-trip would be a pack draft export — future); per-user rosters (deployment-global v1 ceiling, like preset selection and overlays); overlay on full-mode presets; pack manifest changes beyond the prefix rule; MP UI in this change.

## Capabilities

### New Capabilities

- `custom-presets`: the user-composed persona preset — creation/management semantics, the resource-reference universe with composition-time resolution, focused-by-construction composition, the cell-local boundary, and the foreign-owner backstop.

### Modified Capabilities

- `agent-catalog`: the dual-source merge gains the user-defined source (persona-only entries, precedence slot between packs and `agents.json`, `user.` namespace); the generated-preset requirement's focus note extends to custom entries.
- `pack-agent-scoping`: the derivation invariant enumerates the third preset family — a custom preset selects focused mode on its declared resources (full mode still: shipped presets + built-in agent).
- `pack-marketplace`: manifest validation rejects pack agent ids under the reserved `user.` prefix (both at publish and on the cell's install re-validation).

## Impact

- **Code**: `db.js` (user_presets table + CRUD), `catalog.js` (fifth source, serialization `customPreset` + `resourceSummary`), `dsh-profile.js` (resolvePersona/deriveScope third family; preset generation covers custom entries), `skill-materialize.js` (compose root under `custom-skills/presets/<id>/`), `lib/pack-manifest.js` (prefix rule), `pack-store.js` (agentOwner backstop), `server.js` (CRUD routes on the serialized path), web (management page + picker badge).
- **Depends on**: add-persona-resource-sets (resolvePersona, compose roots) and add-focus-overlay (overlay applies to custom presets). Deploys serially last.
- **No changes**: dsh packages, MP client, marketplace plane beyond the shared validator's prefix rule.
- **Ops**: nothing to configure; deployment-global roster semantics documented; probe covers a custom preset as one more focused role.
