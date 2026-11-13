## 1. The produced-file rule in core

- [x] 1.1 Added `producedFilePaths(name, args)` to `packages/core/src/lib/file-tool-paths.ts` — implemented as a SHAPE rule rather than the drafted name allowlist (design.md records the pivot): a call carrying a `command` string goes through the shell scan (except `str_replace_editor`, whose `command` is a mode); a call carrying a path key AND a content key contributes that path; path-only contributes nothing. Multi-harness safe by construction. `npm run test:unit` green with 1.3's cases.
- [x] 1.2 Shell command rule in the same module: candidates from the command string only — the token after `>`/`>>` (skipping `/dev/*`), or any path-shaped token when the segment's verb (after `sudo`/`env`/… prefixes) is on the producing list (`zip tar gzip 7z rar cp mv rsync pandoc ffmpeg convert soffice dd split`); segments split on `&&`/`||`/`;`/`|`. `result` is not a parameter at all.
- [x] 1.3 `scripts/test-produced-files.mjs`: 14 tests pinning write/edit/editor-mutating contributions, read/glob/grep/no-content contributions of nothing, unknown-tool default-deny, the archive/redirect/read-only command corpus (drawn from 605 real transcripts), the `src/a.txt` residual, the `cd && ../` token (reported literally, dropped by `resolveRef`), dedupe+cap 20, shape-not-name dispatch (`Write`/`write_file`/`create_file` admitted; path-only `write` refused), and the new archive extensions.
- [x] 1.4 `tar gz tgz 7z rar bz2 xz` added to `FILE_EXTENSIONS` and the extraction regex's alternation; `looksLikeFile("x.tar.gz")` true and `kindOf` `none` asserted for archives.

## 2. The strip consumes the rule

- [x] 2.1 `web/src/components/TurnArtifactStrip.tsx` loops `producedFilePaths(block.name, block.args)` per done tool block (dedup by resolved rel, the cap inherited from the rule); the existing `usePathSaveStates` existence filter unchanged — it drops `missing`/`invalid`. Typecheck green.
- [x] 2.2 The `visible.length` guard already renders nothing when no candidates survive; pinned by the read-only e2e case (4.2).

## 3. The tool block uses the same rule

- [x] 3.1 `web/src/components/ToolBlock.tsx` gates its per-call open-file action on `producedFilePaths(name, args)[0]`; a read/list call no longer offers the action. Typecheck green.

## 4. e2e

- [x] 4.1 Added "a shell-produced archive surfaces in the strip and opens the drawer" (`e2e/artifact-delivery.spec.js`): a `bash {command: "zip -r <name> docs/"}` block with an output text naming `docs/a.txt` — the chip shows the archive, not the listed input. Green.
- [x] 4.2 Added "a read-only turn surfaces no strip": `bash {command: "ls -la"}` whose result text names an existing file — no strip renders. Green.
- [x] 4.3 The 4.1 case continues into clicking the chip: the drawer opens on the archive with the download-only state (ties to the sibling change, applied first). Green.
- The existing seeded block in this spec (`write_file {path}`, a fictional shape with no content key) failed under the new rule as designed — the seed was corrected to the real dsh shape (`write {file_path, content}`), which incidentally proved the e2e exercises the live rule.
- `findFilePath` was removed with its last callers (strip + tool block), same single-door discipline as the sibling change's `linkRef` removal.

## 5. Gates

- [x] 5.1 `npm run lint` clean on all touched files (repo-level errors are the parallel session's untracked harness files — reproduced with this change stashed); `npm run typecheck` web+miniapp green; `npm run test:unit` 1270/1270; file-surface e2e green (session-open 11/11, artifact-delivery 4/4, attachment-preview/resources-save/resources-page/projects-automation). Full fast suite: 37 failures in untouched settings/packs/permissions surfaces, reproduced identically on a tree with these changes stashed — pre-existing parallel-session state, not gated here.
- [x] 5.2 `git status` shows only `packages/core/src/**`, `web/src/**`, `e2e/`, `scripts/test-*.mjs`, and this change's `openspec/` artifacts (plus `trace.db`, a test-run runtime side effect).
- [x] 5.3 Both accepted limitations stand as assessed and are recorded in design.md; the implementation added one documented pivot (shape dispatch over name allowlist — design.md's Decisions section rewritten to match the code).
