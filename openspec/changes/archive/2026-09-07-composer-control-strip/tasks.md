# Tasks — Composer control strip

Ordered so the zero-risk frontend work ships first and can be validated on its
own, before the backend change that adds a restart path.

## 1. Control strip shell

- [x] 1.1 Add `ControlStrip` to `web/src/components/Composer.tsx` — a row beneath
      the textarea, sharing the line with the attach and send buttons. Purely
      presentational: props in, intent out.
- [x] 1.2 Disable every control when `status !== "connected"`; leave the textarea
      editable (matches the existing local-first behavior at `Composer.tsx:388`).
- [x] 1.3 Add i18n keys for all five locales (`en`, `zh-CN`, `es`, `fr`, `ja`) —
      the `check-locales` build guard fails on a missing key.

## 2. Model control

- [x] 2.1 Render the model control from `useChatStore` `models` + `currentModel`.
- [x] 2.2 Emit `{ type: "set_model", id }` on selection. No local state write.
- [x] 2.3 Show a pending state until `model_changed` lands; disable send meanwhile.
- [x] 2.4 Verify against the running app that switching mid-session restarts the
      runtime and the conversation reloads from disk.

## 3. Effort control

- [x] 3.1 Render only when the active model's `ModelInfo.reasoningEfforts` is
      present and non-empty. No disabled placeholder when absent.
- [x] 3.2 Emit `{ type: "set_effort", effort }`; pending until `effort_changed`.
- [x] 3.3 Remove the control when the model switches to a non-reasoning one.
- [x] 3.4 Extend `e2e/thinking-level.spec.js` to drive the composer control, not
      just the `/models` page.

## 4. Commands control

- [x] 4.1 Add a button that opens the existing `SlashCommandPicker` with an empty
      query. Reuse the component as-is — no new list, no second code path.
- [x] 4.2 Ensure the picker's existing keyboard nav, filter, and Escape-dismiss
      work identically whether opened by click or by typing `/`.
- [x] 4.3 Insert the selected token plus a trailing space and return focus to the
      textarea (same as `acceptAc` at `Composer.tsx:148`).

## 5. Bridge cwd support

- [x] 5.1 Add optional `cwd` to `dsh-bridge.js` `restart()` (currently
      `dsh-bridge.js:207`); store it on the instance so `#spawn()` uses it for
      both the child process and the `initialize` params.
- [x] 5.2 Confirm the automatic backoff restart path also uses the stored cwd —
      an unexpected child exit must not silently revert to the startup directory.

## 6. Workspace switching (server)

- [x] 6.1 Add path validation: absolute, resolves through symlinks to an existing
      readable directory. Reject before touching the runtime — a bad path must
      not cost a restart.
- [x] 6.2 Add `list_workspaces` / `set_workspace` handling in `server/ws.js` and
      the switch logic in `server/agent-session.js`.
- [x] 6.3 Reject `set_workspace` while `isStreaming`, matching the existing
      model-switch guard.
- [x] 6.4 Persist recents under `PLATFORM_DATA_DIR` with an LRU cap. Store the
      resolved path, not the path as typed.
- [x] 6.5 Broadcast `workspace_changed` on success; broadcast `error` and attempt
      to restore the previous workspace on a failed restart.

## 7. Workspace control (client)

- [x] 7.1 Add `set_workspace` / `list_workspaces` / `workspaces` /
      `workspace_changed` to `web/src/types/ws.ts` and handle them in the store's
      exhaustive switch.
- [x] 7.2 Render the control: current workspace as the label, recents list plus an
      absolute-path input in the popover.
- [x] 7.3 Confirm before switching when the session is non-empty; name the
      consequence (transcript will reference paths that no longer resolve).
- [x] 7.4 Surface validation errors inline in the popover rather than as a toast —
      the user is looking at the input they just filled in.

## 8. Verification

- [x] 8.1 Run the full app via `npm start` and exercise all four controls in a
      browser. Type checking does not verify feature correctness.
- [x] 8.2 Check the strip against a non-reasoning model, a disconnected socket,
      and a mid-stream state.
- [x] 8.3 Run the e2e suite and compare failures against a clean stash — this repo
      has known pre-existing flakes.
