# Proposal: wire-produced-files-to-outputs

## Why

A user asked the agent to bundle documents and deliver them. Everything the agent did succeeded — three failures in the UI made it feel broken, all reproduced and pinned in production (cell `1da519d4c1c0bf89`, sessions of 2026-10-14/15):

1. **The Outputs (Files) panel held none of the produced files.** The library's file requirement admits files only by explicit user save (`source=manual`); the cell's `resources` table held exactly one `file` row — one the user had saved by hand. Charts already flow in automatically (`source=auto`), files do not. The produced documents (`markdown-docs/`, `docs/`), `markdown-docs.zip`, `workspace-docs.tar.gz` — all on disk, all real — were invisible in the one surface users treat as "my deliverables".
2. **A shell-produced tar.gz missed the artifact strip.** The real command was `… | sort > /tmp/doclist.txt\ntar -czf workspace-docs.tar.gz -T /tmp/doclist.txt`. The extraction rule splits segments on `&& || ; |` but **not on newlines**, so the `tar` line was glued onto a `sort` segment whose verb is not a producing verb — the whole segment contributed nothing. Replayed against the deployed rule: output was `["/tmp/doclist.txt"]`, no `workspace-docs.tar.gz`.
3. **A python-generated zip was missing from the strip, and a garbage chip appeared instead.** The zip was built inside a `python3 - <<'EOF'` heredoc — `python3` is not a producing verb, so the zip (created inside the heredoc body) was never a candidate. Worse, the heredoc's `print("Zipped", len(files), "files ->", out)` contains `->`, which the redirect regex misreads as a shell redirection; the "target" — a multi-line span of Python source — became a chip literally titled `, out) with zipfile.ZipFile(out) as z: bad = z.testzip() print(`. Opening it shows "This file is no longer available". Replay against the deployed rule confirms this exact candidate is emitted.

The produced-file rule (`wire-shell-produced-artifacts`) was built to be the single answer to "what did this turn produce" — but today its answer only reaches the chat strip. The library — the durable, user-facing surface — ignores it, and the rule itself has two real-command blind spots found in production.

## What Changes

**The rule (three fixes, one function):**

- Multi-line commands split per line: the segment splitter gains `\n`, so a `tar` on its own line is its own segment and contributes its declared outputs.
- Redirect targets are filtered like every other candidate: they must be path-shaped (final-segment file extension), and a segment containing a heredoc marker (`<<`) is exempted from redirect scanning entirely — heredoc bodies are not shell syntax.
- A script-runner segment (`python3`/`python`/`node`) contributes **archive-shaped path tokens** found in it (its command line, `-c` argument, or heredoc body). Archive-shaped = one of the archive/compression extensions. A read of a zip by these runners may also surface it; that is accepted (dedupe makes it harmless, and "the archive this turn discussed is clickable" reads as a feature). Other runners (`perl`, `ruby`, …) join the list only when a real transcript shows them producing.

**The library (auto-capture, chart-shaped):**

- Every assistant turn mirrored to SQLite is examined (the same funnel charts use); for each tool block the produced-file rule yields candidates; each candidate is gated by the same discipline the file-serving and save routes enforce (lexical + realpath containment in the workspace, regular file, size cap), then stored as a durable copy with `source=auto` and the turn's provenance (session id, session title snapshot, message id).
- Dedup is by content hash across the cell, exactly as charts: same bytes → refresh `last_seen_at` only; changed bytes → a new row (history preserved, no silent overwrite). The strip's "already in library by content" state and the library's no-duplicate-save guarantee are the same hash column, so the two surfaces agree by construction.
- Capture covers every lane that mirrors turns — web/WS, dsh events, scheduled tasks (cron), delegation — because the hook is in the one synchronous funnel they all share. Capture failure is a logged skip, never a failed mirror.

**The backfill (one cell, one run):**

- A one-shot script stages into the pod and rescans existing workspaces with the same rule and gates, marking rows `source=auto` with empty provenance. Scoped by `--cell`; run for the affected cell now, available for others later. Without it the change only helps future turns and the user's three reported files stay invisible.

**Not in scope:** UI badges distinguishing auto from manual rows; per-lane capture filters; `cd`-resolution in shell commands; non-archive tokens from script-runner bodies (`open('data.csv')` stays invisible — readers are not producers).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resource-library`: the file requirement "Files enter the library by explicit save, and saved bytes are durable copies" is split — explicit save keeps its contract unchanged, and a new requirement covers automatic capture of produced files from mirrored turns (gating, dedupe, provenance, every-lane scope, never-fail-the-mirror). The typed-provenance requirement already describes `auto` capture generally; it needs no delta.
- `file-preview`: the produced-file rule requirement gains the three rule fixes (per-line segments, filtered redirect targets, heredoc exemption, script-runner archive tokens) — each with a scenario pinned to the real production command that failed.

## Impact

- `packages/core/src/lib/file-tool-paths.ts` — the rule: segment split, redirect filter + heredoc exemption, script-runner archive tokens. Consumed by web, mini program, and now the server's capture module.
- `resources.js` — `saveFile` gains an internal-caller variant (or a shared core: gate → hash → store → insert with a `source` parameter) so auto-capture and manual save cannot drift; new `captureFilesFromTurn` alongside `captureFromMessage`.
- `chat-history.js` — the mirror funnel calls the file capture next to the chart capture; `workspaceRoot` is already in scope there (`dshBridge.getCwd()`), which the current manual-save route does not need.
- `scripts/test-produced-files.mjs` — the three rule fixes with the real production commands as pinned cases.
- `scripts/backfill-workspace-resources.mjs` — one-shot, `--cell <id>`, same rule + gates, idempotent by content hash.
- e2e: archive via multi-line command surfaces in the strip; produced file appears in the Outputs panel without manual save; heredoc-generated zip surfaces instead of the garbage chip.
- The mini program needs no dedicated change: it consumes the same core rule and the same resources API.
