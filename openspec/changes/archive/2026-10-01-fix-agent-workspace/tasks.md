# Tasks: fix-agent-workspace

## 1. Boot resolution

- [x] 1.1 Extend `validateWorkspace` (server/agent-session.js) with a W_OK check naming writability in the rejection reason; verify unit: read-only temp dir rejected, writable dir passes, existing validations unchanged
- [x] 1.2 Implement `resolveBootWorkspace()` (env pin → persisted `workspace.current` → process.cwd(), first valid tier wins, loud log on a rejected pin) and pass the result as the DshBridge `cwd` in server.js; verify boot probes: pin wins over preference, preference restored without pin, invalid pin falls back with the warning

## 2. Persistence on switch

- [x] 2.1 Persist `workspace.current` inside `switchWorkspaceToInner` on success and on the failed-switch restore path; verify e2e: switch → restart server → `list_workspaces.current` is the switched path (no env set)
- [x] 2.2 Verify e2e: `set_workspace` into a read-only directory is rejected with a writability error and the runtime does not restart

## 3. Deploy wiring + suite

- [x] 3.1 Add `AGENT_WORKSPACE` to .env.example and DEPLOY.md (fd-prod: `/data/workspace` under the persistent volume, owned by the app user); k8s/compose creates the dir in the image; verify the deployed pod boots with the pinned workspace and `/api/files` serves a file the agent wrote
- [x] 3.2 Run the full e2e suite (dev flow unchanged: no env, no preference → process.cwd()) and `openspec validate --strict` for this change
