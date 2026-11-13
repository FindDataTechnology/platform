# Design: fix-agent-workspace

## Context

On fd-prod the dsh child inherits `process.cwd()` (`/app`, root-owned, unwritable). The agent writes to `/tmp`; `/api/files` serves `dshBridge.getCwd()`; the resource-library save validates against the same root — produced files are unreachable by every consumer. The switcher persists only recents, so a user's workspace switch evaporates on restart. See proposal.md for the live incident.

## Goals / Non-Goals

Goals: a deployment's workspace is writable by construction, survives restarts, and can never silently regress to an unwritable root; no behavior change for dev/desktop (no env, no persisted preference → exactly today).

Non-Goals: per-user workspaces (tenant-cell end state); sandboxing or path allowlists; serving files outside the workspace root; migrating `/tmp`-era files (none worth rescuing per the incident).

## Decisions

### D1 — Precedence chain resolved once at boot, validated once

`resolveBootWorkspace()` in server.js init: `AGENT_WORKSPACE` → persisted `workspace.current` → `process.cwd()`, each tier passing through `validateWorkspace` extended with `W_OK`. First valid tier wins and is handed to the DshBridge constructor (already a parameter — the bridge needs no change). A rejected `AGENT_WORKSPACE` logs `[workspace] AGENT_WORKSPACE=<v> rejected (<reason>); using <fallback>` — the loud warning the spec demands, and the diagnostic the fd-prod incident lacked.

*Alternative rejected*: env as default-only (preference always wins) — a stale preference from a manual/dev switch is precisely how a production deployment gets stranded; the pin exists to override drift.

### D2 — Persistence rides the existing preference row, written inside the mutation

`workspace.current` via `db.getPreference/setPreference` (same store as the recents key, same corruption tolerance — a missing row is just "no tier-2 input"). Written inside `switchWorkspaceToInner` on success AND on the restore path of a failed switch (the restored path is the truth the next boot should honor). One key, no schema change, no migration.

### D3 — `validateWorkspace` gains W_OK for both callers

The switch path and the boot path share the validator, so "writable" is one rule, not two. Rejection at switch time keeps an unwritable target from being switched into (the picker error names writability); rejection at boot time is a fallback, never fatal. Desktop/dev pickers of read-only browse directories will newly be rejected — correct per the spec (a read-only workspace is the failure mode), and the desktop supervisor's default workspaces are user-writable.

## Risks / Trade-offs

- [Persisted preference points at a directory that vanished] Boot validation fails → tier-3 fallback with the loud log; the recents list still shows it; user re-switches. No boot failure possible from stale state.
- [Desktop dev flow picks a repo dir owned by another user] W_OK rejects with the reason — surfaced in the picker's existing error toast; strictly better than switching into a root that breaks file delivery.
- [Bridge restart cost on a mid-flight boot restore] None — resolution happens before the first spawn, not after.

## Migration Plan

1. Image/compose: create the workspace directory under the persistent data volume, owned by the app user (fd-prod: `/data/workspace`).
2. Set `AGENT_WORKSPACE` in the deployment env; deploy. Existing sessions' absolute-path references to `/tmp` files stay dead (accepted; the incident's files are not worth rescuing).
3. Rollback: unset the env — behavior returns to today's (preference tier already populated by any post-deploy switches; harmless).

## Open Questions

- Whether the ops console should surface the resolved boot workspace and its tier — nice-to-have, deferrable to the next ops-console touch.
