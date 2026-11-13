# Design: wire-produced-files-to-outputs

## Context

Facts verified against production (cell `1da519d4c1c0bf89`, its SQLite via in-pod node, and replaying the deployed rule with `node --experimental-strip-types`):

- **The rule's blind spots are mechanical, not hypothetical.** The tar command that failed is verbatim from the session DB; replaying it through `producedFilePaths` yields `["/tmp/doclist.txt"]`. The heredoc command yields the Python-source garbage candidate. Both reproductions are stable and become pinned tests.
- **The garbage chip's birth path is the redirect regex.** `>>?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)` matched `-> ` inside a Python `print(...)`, capturing the quoted multi-line span up to the next quote. Redirect targets skip the extension filter today because the extension filter lives only in the producing-verb branch (`pathTokens`).
- **The library's file path is manual-only by spec** (`resource-library`: "A file SHALL become a resource only by explicit user action"), and the runtime matches it: `saveFile` hardcodes `source: "manual"`. Charts prove the auto pattern exists end-to-end: `captureFromMessage` rides `recordMessage`'s mirror funnel in `chat-history.js:183-202`, inserts with `source: "auto"`, dedupes by content hash via `db.findResourceByHash`, and is wrapped in try/catch so capture never fails the mirror.
- **`saveFile`'s gate is exactly the capture gate we need**: `resolveUnderRoot` (lexical containment), realpath (symlink escape), `stat` (regular file), `MAX_FILE_BYTES`, hash → `findResourceByHash` dedupe, write-then-rename into the resources dir, provenance fields. The only mismatch is the hardcoded `source: "manual"`.
- **The mirror funnel already has `workspaceRoot` in scope** (`dshBridge?.getCwd?.()` at chat-history.js:179, used for `normalizeFunctionalRefs`).
- **The server is plain JS and does not depend on `@platform/core`** (no package.json dep, no /app/packages in the image). The core rule is TypeScript. Node ≥23.6 strips types natively and the image runs Node 25 — `scripts/test-produced-files.mjs` already imports the TS file directly under this guarantee.
- The three user-visible problems were reproduced in the deployed rule *before* this change; the same replays after the fix are the acceptance replay.

## Goals / Non-Goals

**Goals:**

- One rule, three consumers: chat strip (web), tool-block action (web), library capture (server). No client-side reimplementation.
- Produced files appear in Outputs without user action, with provenance, deduped, durable (workspace deletion does not remove the copy).
- The three production failures become pinned test cases at the rule level and e2e level.

**Non-Goals:**

- UI badges for auto vs manual rows (deferred; data already distinguishes them via `source`).
- Per-lane capture filters (cron/delegation produce; if noisy later, filter at the same funnel — a data question, not an architecture one).
- Resolving candidates against a `cd` inside a command (pre-existing limitation, unchanged).
- Capturing non-archive tokens from script bodies (readers are not producers — see Decisions for the archive exception).
- Backfill for cells other than the affected one (the script takes `--cell`; running it more widely is an operator decision, not a code path).

## Decisions

**Decision: the rule stays in core and the server imports the TS directly.**

The server currently has zero dependency on `@platform/core`. Two options existed: (a) server imports `packages/core/src/lib/file-tool-paths.ts` directly (Node ≥23.6 type stripping; image runs Node 25 — verified working pattern in scripts), or (b) a thin JS copy in server/ with a contract test pinning the two to identical outputs.

Chosen: **(a), with a boot-time self-check.** (b)'s contract test exists to catch drift; (a) cannot drift by construction. The risk of (a) is packaging — so the Docker build must keep `packages/core/src/lib/file-tool-paths.ts` in the image (it is plain source, not built output; the Dockerfile copies the repo tree), and the capture module adds a startup assertion (import + one known vector) whose failure logs loudly. Fallback if the image proves hostile: switch to (b) — the rule is one pure function and the contract test is 20 lines; the change's tasks track this as a contingency, not a fork of the design.

**Decision: dedupe semantics are the hybrid (same hash → refresh; changed bytes → new row).**

The library already keys no-duplicate on `content_hash` (`findResourceByHash`), and the strip's "already in library by content" state reads the same column. Overwrite-in-place would silently destroy earlier bytes (the durable-copy promise); row-per-version would flood the panel under regeneration loops. The hybrid falls out of the existing primitive for free: same hash → `insertResource` returns `inserted:false` and capture only bumps `last_seen_at`; new hash → new row. No new columns, no migration.

**Decision: script-runner segments contribute archive-shaped tokens only.**

The shape rule's foundation is "a reader is not a producer". `python3 -c "open('data.csv').read()"` must not make `data.csv` a deliverable. But the archive case is empirically the deliverable case (both production failures were archives), and archive extensions are already the rule's strongest file signal (`FILE_EXTENSION_SRC`'s archive family). Scope: a segment whose verb (after prefix unwrapping) is `python3`/`python`/`node` contributes `pathTokens` matching the **archive alternation** (`zip|tar|gz|tgz|7z|rar|bz2|xz`) found anywhere in the segment — command line, `-c` argument, or heredoc body, since the heredoc is part of the segment text. Heredoc bodies are scanned for these tokens only after the redirect exemption removes their false-positive path. Accepted cost: a turn that merely *verifies* a zip (`zipfile.ZipFile('x.zip')` integrity check) surfaces `x.zip` as a candidate; harmless via dedupe, arguably correct ("this turn's discussed archive is clickable").

**Decision: redirect targets pass the same `pathTokens` filter, and heredoc segments are exempt from redirect scanning.**

The garbage chip exists because redirect targets bypass the extension filter. Rather than special-casing, redirect targets join the same admission path as verb candidates: a target must be path-shaped (file extension). `> /tmp/doclist.txt` stays a candidate (the capture gate rejects `/tmp` later; the strip shows it only if it exists — in production it did not, and the strip's existence filter dropped it, which is why only the garbage chip appeared). The heredoc exemption (`<<` in segment → skip redirect scan on that segment) is defense in depth: it removes the entire class of "pseudo-redirect inside a heredoc" (`->`, `=>` in code) rather than trusting the extension filter to catch every shape. Both layers are tested.

**Decision: capture wraps `saveFile`'s core, not a parallel writer.**

`saveFile` is refactored minimally: the gate → hash → store → insert body becomes an internal function taking `source`, and both the HTTP route (`source:"manual"`) and the capture path (`source:"auto"`) call it. Drift between capture and save discipline (containment, realpath, cap, dedupe, durability) becomes impossible by construction — the same argument the single-door rule makes. `captureFilesFromTurn` sits next to `captureFromMessage` in resources.js, iterates the turn's tool blocks through `producedFilePaths`, gates each candidate, and never throws.

**Decision: the backfill is a staged one-shot script, not a migration.**

Existing workspaces predate the capture hook. A migration would run inside every boot with no way to scope it; the affected cell is one operator decision. The script (`scripts/backfill-workspace-resources.mjs --cell <id>`) reuses the same capture function (imported, not copied) against the cell's workspace directory listing, marking rows `source:auto` with empty provenance (session linkage unknown for historical files; the spec's soft-reference model handles null session ids). Idempotent by content hash. It runs on the pod via the established `/tmp/rt` staging recipe.

## Risks / Trade-offs

- **[Noisy Outputs]** Every produced file enters the panel — including scratch files (`hello.txt`-class). Accepted explicitly at grill (user chose 4b "全部产出文件"); the mitigation path (size/extension filters) is additive and does not change the capture contract.
- **[Rule change ripples to the strip]** The three rule fixes change what the chat strip shows for *historical* sessions (render-time synthesis). For the affected cell this is the fix, not a regression; for other sessions, candidates can only grow (split-line segments, archive tokens) or shrink (filtered redirect targets — the shrink being the garbage chip's death). Tests pin both directions.
- **[TS-in-image dependency]** If the packaged image ever drops the core source tree, capture breaks at import time. Mitigation: boot-time self-check with a loud log; documented contingency to inline the function (contract test prevents drift).
- **[Hash dedupe across cells]** `findResourceByHash` is per-cell DB; two cells producing identical bytes each get a row. Correct (resources are cell-local), noted so nobody "fixes" it into cross-cell dedupe.

## Migration Plan

No schema migration (dedupe uses the existing `content_hash` column; `source` already has the `auto` value). Deployment is the standard platform roll; the backfill script runs once after the roll against the affected cell. Rollback: revert manifests to the prior `sha-` tag; captured rows remain (harmless, durable by design) and manual save continues to work on the prior build.

## Open Questions

None — the grill settled: rule scope (Q1), dedupe semantics (Q2), backfill scope/marker (Q3), lane coverage (Q4, all lanes via the funnel), UI badges (Q5, deferred).
