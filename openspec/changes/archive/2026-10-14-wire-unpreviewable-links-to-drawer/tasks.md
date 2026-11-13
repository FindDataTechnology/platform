## 1. Unit coverage for the shared link rule

- [x] 1.1 Added `scripts/test-file-ref-rule.mjs` covering `kindOf`/`extOf`/`fileLinkRef`/`resolveRef` from `packages/core/src/lib/file-ref.ts` (Node strips the TS import natively). Pins that `fileLinkRef` admits `zip`/`xlsx`/`doc`/`json`/`yaml`/`xml`/`tsv` while `kindOf` reports `none` for them, that route hrefs are admitted regardless of extension, that external URLs and non-file targets are refused, and that a leading-`../` escape is refused (mid-path traversal resolves lexically and is stopped by the server route — probed 403; the split of responsibility is pinned as its own test). `npm run test:unit` green.
- [x] 1.2 The baseline assertion was replaced by a regression guard: `linkRef` was REMOVED with its last caller (zero production callers after the switch), and the test now asserts `coreModule.linkRef === undefined` so the narrow door cannot come back.
- [x] 1.3 `MarkdownLink` in `web/src/components/Markdown.tsx` switched from `linkRef` to `fileLinkRef`; comment updated to the new rule. `npm --prefix web run typecheck` green.
- [x] 1.4 No caller remained after the switch (verified by exhaustive grep), so `linkRef` and its re-exports were removed. Both clients' typechecks green.

## 2. The drawer reports a vanished file instead of offering a dead download

- [x] 2.1 `web/src/components/preview/PreviewDrawer.tsx`: the download-only state issues a `HEAD` against `target.url` on mount when `kindOf(name) === "none" && target.ref` (server-backed, no renderer); non-2xx renders `preview.unavailable` in place of the download action. Types with a renderer pay no check; a failed check stays optimistic (the download itself reports). Verified in e2e (see 4.3).
- [x] 2.2 `preview.unavailable` added to all 5 locale bundles; `npm run check:locales` green (1249 keys each).

## 3. e2e: the relative-path form and the changed rule

- [x] 3.1 The comment at `e2e/session-open.spec.js:388` rewritten to the shipped rule (route refs admitted regardless of extension; the relative-path case covered by the sibling spec).
- [x] 3.2 Added "a relative link to an unrenderable produced file opens the drawer" (bare relative `.zip` link → drawer → download action visible).
- [x] 3.3 Added "a link to an unrenderable file that is gone reports it instead of offering a dead download" (file removed → reopen link → `no longer available` text, download action count 0).
- Mutation-checked: reintroducing the narrow gate (kindOf === none → return) turns 3.2/3.3 red and the shipped code green, so the cases genuinely pin the fix.

## 4. Gates

- [x] 4.1 `npm run lint` — clean on every file this change touches; the 2 repo-level errors live in the parallel session's untracked `agent-runner/harness/*` / `scripts/test-harness-adapter.mjs` (verified present before/after stashing this change). `npm run typecheck` (web + miniapp) green. `npm run test:unit` 1270/1270. File-surface e2e green: session-open 11/11, attachment-preview, resources-save, resources-page, projects-automation (21+ passing incl. the two new cases). The FULL fast suite shows 37 failures in settings/packs/permissions surfaces this change never touches — reproduced identically on a tree with this change stashed (pre-existing, parallel-session state), so not gated here.
- [x] 4.2 `git status` shows only `web/src/**`, `packages/core/src/**`, `e2e/`, `scripts/test-file-ref-rule.mjs`, locale bundles, and this change's `openspec/` artifacts (plus `trace.db`, a test-run runtime side effect not part of the change).
