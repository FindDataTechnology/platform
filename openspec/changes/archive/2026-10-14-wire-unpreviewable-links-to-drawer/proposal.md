## Why

A file the agent produces that the web client has no renderer for — `.zip` above all — is undownloadable from the conversation. The artifact contract teaches the model to reference files with workspace-relative markdown links, and it does; but the web's link rule (`linkRef`) admits only the types that have a renderer (`EXT_KIND`), so a `.zip` link falls through to a plain anchor that navigates to a relative path instead of opening the drawer. The same file is recognized on the mini program, which resolves links through the broader `fileLinkRef` rule — so one agent output behaves differently per client, and the web one is a dead end. Verified against the live route: the server serves `.zip` fine (`attachment`, `application/octet-stream`); the break is entirely in the web link rule.

## What Changes

- The web chat's markdown link rule switches from `linkRef` (renderable types only) to the broader `fileLinkRef` rule, so a link naming any produced-file type opens the preview drawer. A type with no renderer lands on the drawer's existing download-only state, which already offers the file.
- The web then admits the same produced-file set the mini program already admits, ending the web/mini-program divergence for unpreviewable types (`.zip`, `.xls/.xlsx`, `.ppt/.pptx`, `.doc`, `.json`, `.yaml/.yml`, `.xml`, `.tsv`). The mini program's own behavior is unchanged, so only the web-facing rule changes.
- For a type newly admitted by the broader rule, the drawer confirms the file still exists before presenting download as the action, so a link to a vanished file reports that instead of offering a download that 404s. Types that already had a renderer keep today's optimistic behavior — their renderers already degrade to the download state on failure.
- Tests for the shared rule: `linkRef` / `fileLinkRef` / `kindOf` have no unit coverage today, and this change alters exactly which types the web admits.

Non-goals: no server route change (the route already serves these types); no new renderer; no change to what the turn artifact strip captures (shell-produced files are a separate change).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `file-preview`: the requirement "File references open the preview" gains the rule that a link naming a produced file of any recognized type — not only a renderable one — opens the drawer, and that an admitted type whose file no longer exists reports that rather than offering a dead download.

`resource-library-ui` needs no delta: its mini-program chip requirement already admits every produced-file type, and this change brings the web up to that rule rather than altering the mini program's.

## Impact

- `web/src/components/Markdown.tsx` — the `MarkdownLink` renderer's resolver call (`linkRef` → `fileLinkRef`), and the comment describing which links it claims.
- `web/src/lib/file-preview.ts` — re-exports; `linkRef` may remain exported for other call sites, or be dropped if this was its last consumer (verify).
- `web/src/components/preview/PreviewDrawer.tsx` — the download-only state gains an existence check for newly admitted types.
- `packages/core/src/lib/file-ref.ts` — no behavior change expected (`fileLinkRef` and `FILE_EXTENSIONS` already exist and already include `zip`); verify no rule needs adjusting for the `../`-free relative form the artifact contract produces.
- Tests: new unit coverage for the shared rule in `packages/core`; `e2e/session-open.spec.js:384` asserts behavior that relies on the CURRENT narrowing (its comment says the previewable-extension rule does not gate route hrefs) — that assertion must be re-read and updated to the new rule.
- No API, schema, dependency, or deployment change.
