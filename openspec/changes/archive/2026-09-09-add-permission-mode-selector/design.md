# Design — add-permission-mode-selector

## Context

The generated platform profile already composes `dsh-permission-presets`
(with `read-only` / `workspace-write` / `danger-full-access`, each bundling a
sandbox mode + approval policy; default from `DSH_PERMISSION_MODE`, today
`workspace-write`). The runtime service supports live switching:
`PermissionPresetService.set(session, name)` appends the durable
`permission/preset` event and writes the two knobs through their canonical
setters; `names` / `optionOf` expose the roster with client presentation.
None of this reaches the platform because the stock `sdk-jsonrpc-server`
speaks only `initialize` + `session/prompt`.

`add-dsh-agent-presets` (lands first) introduces the local bridge plugin —
a repo-authored file subclassing `HarnessSdkJsonRpcServer`, inserted as the
`sdk-jsonrpc-server` row via a generated `--patch` overlay — with a
`handleRequest` dispatch override. This change extends that plugin with two
more methods; it does not introduce a new plugin row or dependency.

## Goals / Non-Goals

**Goals:**
- Factual visibility: the strip always renders the runtime's effective
  preset, never a stale local wish.
- Live switch, no restart — deliberately unlike model/workspace/preset
  switching, because the runtime supports it and a restart would silently
  reset the mode.

**Non-Goals:**
- No Settings surface for the deployment default (`DSH_PERMISSION_MODE`
  stays the knob).
- No interactive approval answerer (asks under `ask` policy still fail
  closed; a follow-up change owns the prompt UI).
- No preset authoring/custom tables — the composed table is what it is.

## Decisions

### D1 — A subclassing bridge file + a third overlay, not a second server plugin
As built: `dsh-profile-template/platform-permission-bridge.js` subclasses
`PlatformSdkServer` and adds the two `permissions/*` branches to its
`handleRequest`; `writePermissionsPatch()` writes a third overlay
(`permissions.patch.yml`) that disables the `platform-sdk-server` row and
inserts `platform-permission-server` pointing at the new file, passed to
spawn AFTER the presets overlay (a cordis patch cannot rewrite an inserted
row's plugin name — the same disable+insert constraint the presets overlay
records; ordering is fixed in dsh-bridge.js). Alternative considered: two
branches directly inside `platform-preset-bridge.js` (single file, one
overlay) — rejected because that file is owned by the in-flight
`add-dsh-agent-presets` workstream and concurrent edits would collide; the
subclass keeps the two features independently owned while sharing one
runtime server. The small stock `apply` duplication is the cost.

The bridge resolves the service with `this.ctx.get("permissionPresets")` and
the live session from its own session map (the same map `getOrCreateSession`
maintains). `permissions/set` calls `service.set(session, name)`; unknown
names throw and surface as a JSON-RPC error, which the platform forwards as
a WS `error` to the requesting client only.

### D2 — Read-back is event-driven, plus a live RPC for explicit refreshes
Every dsh session event already reaches the platform as a `session.event`
notification, so a `permission/preset` switch (or the initial pin when a
fresh session publishes) flows straight into the `current_permission`
broadcast via one new translation case — covering switches from every
origin, including the child's own session creation after a restart. The
`permissions/list` RPC carries the roster plus the bridge's live current
value (last-seen event, else the service default) for the client's explicit
refresh: on connect, and after a restart-carrying switch completes. The
bridge subclass also keeps its own per-child map answering from the same
events — no log replay, no polling loop. An unmatched knob combination
surfaces as `custom` on the roster read path.

### D3 — Streaming guard on the platform side
`set_permission` is rejected while `isStreaming`, exactly like `set_model`,
even though the runtime queues policy transitions for the next model step.
Rationale: consistency (one rule for "runtime config changes mid-turn") and
auditability — a permission loosening should never interleave with a turn it
was not visible to.

### D4 — Restart resets to the deployment default, shown honestly
A child restart creates a fresh session pinned to `defaultPreset`. We do not
persist the user's last selection across restarts (alternative: a
`permission.preset` preference re-applied at initialize — deferred; loosing
permissions silently on every model switch is a safer failure mode than the
reverse). The store clears `currentPermission` when `pendingConfig` starts
and re-renders from the post-restart roster, so the chip shows the default
again without user action.

### D5 — UI: one `StripMenu` chip in the control strip
Same shell as effort/model: icon + effective name + chevron, menu rows with
`label` + `description` from `optionOf`, checkmark on current, `custom`
shown as a non-switchable current value when derived. Localized labels for
the three shipped presets come from the web i18n bundles (five locales),
mirroring the presets change's rule; unknown/user table entries render the
server-provided label verbatim.

## Risks / Trade-offs

- [Approval asks fail closed under `ask` presets] → Documented in the
  proposal; the selector still helps because `danger-full-access` (approval
  `never`) and sandbox confinement do not depend on the answerer. Follow-up
  change owns the prompt surface.
- [The exact JSON shape of `optionOf`'s `PresetOption`] → Verify against
  `dsh-permission-presets/lib/types/types.d.ts` during implementation and
  adapt the bridge serializer (same verification stance as the presets
  roster).
- [Sandbox enforcement differs by platform (landlock on Linux, seatbelt on
  macOS, none on Windows)] → The selector reports the preset, not the OS
  enforcement level; out of scope to normalize.

## Migration Plan

No data migration. Deploy order: after `add-dsh-agent-presets` (the bridge
plugin file and its patch overlay must exist). Rollback = revert the web +
server handlers; the bridge methods are inert if unused.

## Open Questions

- None blocking. If `PermissionPresetService` is absent from the composed
  tree in some deployment (hand-edited profile), the roster fetch returns
  empty and the control stays hidden — degrade, don't boot-fail.
