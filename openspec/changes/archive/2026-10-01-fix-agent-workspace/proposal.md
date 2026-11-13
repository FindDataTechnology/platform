# Proposal: fix-agent-workspace

## Why

On fd-prod the dsh child's cwd defaults to `process.cwd()` — `/app` in the container, root-owned and unwritable. The agent works around it by writing to `/tmp`, but `/api/files` serves the workspace root (`dshBridge.getCwd()`), so produced files are neither previewable, downloadable, nor savable to the resource library ("该文件不在工作区内" / 404 on the links). The workspace switcher works but only persists *recents* — restart resets the cwd to `/app`, recreating the problem (confirmed live: an agent in a writing session told the user "这个环境没有公开可点的下载链接" after probing `/api/files`). The user-facing symptom is "文件面板无法访问": the file pipeline is only reliable until the next restart.

## What Changes

- **Boot-time workspace resolution with an env pin**: new `AGENT_WORKSPACE` (absolute path) sets the deployment's workspace. Precedence: `AGENT_WORKSPACE` (validated: exists, readable, **writable** — falls back to `process.cwd()` with a loud warning if invalid) > persisted current-workspace preference > `process.cwd()`. The env pin wins over the preference so a drifted or dev-path preference can never strand a deployment in an unwritable root.
- **Persisted current workspace**: a successful `set_workspace` writes the current-workspace preference (alongside today's recents); boot restores it. The switch-then-restart reset loop is gone.
- **Writability guard in the picker**: `validateWorkspace` (R_OK|X_OK today) also checks W_OK — switching into a read-only directory recreates the exact failure this change fixes, so the target must be writable (reject with the reason; a read-only browse mode is not a workspace).

Non-goals: per-user workspaces (each user's cell owns its own workspace in the tenant-cell end-state — this change makes the single shared workspace correct and durable first); sandboxing or path allowlists (unchanged posture — real sandboxing belongs to tool permissions); serving files outside the workspace root.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `workspace-selection`: boot-time resolution gains the env pin + persisted-current precedence and a writability requirement; the switch validation requirement extends to W_OK; the "recents survive a server restart" scenario is joined by "the current workspace survives a server restart".

## Impact

- **Code**: `server.js` initDshAgent (resolve + pass `cwd` to DshBridge — the bridge already takes it), `server/agent-session.js` (persist current workspace in switchWorkspaceTo, W_OK in validateWorkspace), `dsh-bridge.js` unchanged (cwd already a constructor/restart param).
- **Deploy**: fd-prod sets `AGENT_WORKSPACE` to a writable mounted path (e.g. under the data volume) and ensures it exists in the image/compose; one-time switch to land existing `/tmp`-era files is manual (none worth rescuing per the live incident).
- **No changes**: `/api/files` route (serving root already follows the bridge cwd), dsh packages, MP client.
- **Testing**: e2e — boot restores persisted workspace; env pin overrides preference; unwritable target rejected at boot-fallback and switch paths.
