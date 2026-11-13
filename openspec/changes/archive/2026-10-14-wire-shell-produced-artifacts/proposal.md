## Why

The turn artifact strip exists so a file a turn produced surfaces even when the model never links it — the spec says the file set is derived from what the turn's tool calls "produced or modified". The current extraction does not honor that: it scans a fixed set of argument keys and the tool's result text, with no notion of which tools produce files at all. Measured against 605 real session transcripts and the shipped tool schemas:

- A consumer's input is reported as a product. `ls -la` lists files; the strip lists the listed files as this turn's artifacts. `read`/`sed`/`wc` name a file they are reading; the strip calls it produced. These are violations of the strip's own requirement, running in production today.
- A shell-produced file is invisible. `zip -r bundle.zip src/` produces `bundle.zip`; the strip shows `src/a.txt` instead — an input, extracted from zip's stdout. When the command prints nothing useful, the strip shows nothing at all, which is the reported symptom: a conversation-generated `.zip` with no way to reach it.
- Archive extensions are absent from the shared table entirely, so `.tar.gz`, `.7z`, `.rar`, `.bz2`, `.xz` are unrecognized on both clients — independent of the shell problem.

Shell tool calls are common in real use (`bash` is the second-most-used tool across the sampled transcripts), and archives are a natural thing to produce. Today both the false positives and the blind spot are live.

## What Changes

- File-path extraction becomes tool-aware. A tool known to produce files (write, edit, the string-replace editor in its mutating modes, shell) contributes candidates; a tool known to consume files (read, glob, grep, the editor's view mode) contributes none. Unknown tools contribute none.
- A shell tool call contributes candidates from its **command string** — the produced-file signal — rather than from its output text. A candidate is taken when the command redirects into it (`>`/`>>`) or when the command's verb is on a known archive/copy/conversion list. Read-only commands (`ls`, `curl`, `git status`, `sed -n`) contribute nothing.
- Candidates are validated by the existing server lookup before display, and only existing files appear. This reuses the call the strip already makes; the client's "which of these still exist" filter is unchanged.
- The shared produced-file extension table gains the archive and compression extensions (`tar`, `gz`, `tgz`, `7z`, `rar`, `bz2`, `xz`) so both clients recognize them.
- The strip keeps its contract: render-time synthesis, no persistence, no model-visible change, identical rendering for historical sessions.

Non-goals: no `cd` tracking in shell commands (a candidate written relative to a directory the command `cd`s into is not resolved); no content- or mtime-based "was this actually written this turn" check (the server capability that would prove it does not exist yet); no change to the preview/link rule (separate change).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resource-library-ui`: the turn-artifact-strip requirement gains the rule that the file set is derived from tools that produce files, that a shell call's candidates come from its command string, and that read-only tools contribute nothing — the current text asserts derivation "from tool call paths" without saying which tools count.
- `file-preview`: gains a new requirement fixing which tool calls count as producing a file (the existing "File references open the preview" requirement states what a produced file gets, but never says how "produced" is determined — which is why a read call currently offers an open-file action).

These two touch different requirement blocks, and neither touches the requirement the sibling change `wire-unpreviewable-links-to-drawer` modifies, so the two changes archive independently in either order.

## Impact

- `packages/core/src/lib/file-tool-paths.ts` — the extraction rule; gains producer/consumer dispatch and a shell-command candidate scan. `findFilePath` keeps its current single-path contract for existing callers, or is joined by a new multi-candidate function (decided in design).
- `packages/core/src/lib/file-ref.ts` — `FILE_EXTENSIONS` gains the archive/compression extensions.
- `web/src/components/TurnArtifactStrip.tsx` — consumes the multi-candidate rule; its existing existence filter already drops candidates the server reports missing.
- `web/src/components/ToolBlock.tsx` — same rule for its per-call file action.
- Tests: unit coverage for the new rule (producer dispatch, command scanning, the read-only cases that must yield nothing); e2e for a shell-produced archive reaching the strip.
- No server route, API, schema, or data change; no mini program change (it consumes the shared rule and benefits from the extension additions).
