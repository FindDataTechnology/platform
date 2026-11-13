## Context

See proposal.md — Why. Facts that shape the approach, all verified against the shipped runtime (dsh 0.2.0-rc.2 tool packages) and 605 real session transcripts:

- **Tool names and argument shapes are known and stable.** `write` / `edit` / `read` take `file_path`; `str_replace_editor` takes `command` (`view`|`create`|`str_replace`|`insert`) plus `path`; `bash` takes `command` plus `description`. Real frequency: `write` 42, `bash` 36, `str_replace_editor` 25, `read` 20.
- **The `workdir` parameter exists but is unused in practice** (0 real occurrences; the 555 text matches were the tool's own description). Commands that change directory do it inline (`cd out && ...`).
- **The current extractor scans argument keys and result text with no tool awareness.** Measured consequences: `ls -la` contributes the files it listed; `zip -r bundle.zip src/` contributes `src/a.txt` (an input, read from zip's stdout); a command whose output says nothing contributes nothing.
- **Command-string scanning is markedly cleaner than result-text scanning.** Same regex, applied to the command instead of the output: `zip -r bundle.zip src/` → `bundle.zip`; `cd out && zip -q ../bundle.zip *` → `../bundle.zip`; `ls -la && git status --short` → nothing.
- **Archive extensions are missing from the shared table**, so `.tar.gz`/`.7z`/`.rar`/`.bz2`/`.xz` are unrecognized on both clients. This is independent of the hyphen question — probed: `release-2026-10-14.zip` matches fine, `release.tar.gz` does not, with or without hyphens.
- **The strip already validates existence server-side.** `usePathSaveStates` calls `POST /api/resources/lookup` and the strip filters out `missing`/`invalid` entries today. The server caps a lookup at 20 paths.

## Goals / Non-Goals

**Goals:**

- The strip lists what the turn produced and stops listing what it merely read.
- A shell-produced file (archive above all) reaches the strip.
- One rule for both clients, since the mini program consumes the same core module.

**Non-Goals:**

- Resolving paths relative to a directory the command `cd`s into. Deferred deliberately (see Decisions).
- Proving a file was written *this turn* by content or timestamp. The server capability to answer that does not exist; existence is the v1 proxy.
- Recognizing arbitrary "can produce files" commands (`python -c`, `node`, `make`). Deferred; redirection covers the common case.

## Decisions

**Decision: dispatch by call SHAPE, not by a tool-name allowlist.**

Implemented shape rule (pivoted from the name allowlist during implementation — see the note below):

```
a call carrying a `command` STRING        → shell scan (the rule below); except
                                            str_replace_editor, whose `command`
                                            is a mode name, handled by its branch
a call carrying a path key AND a content
key (content/file_text/new_string/new_str/
text/contents/body/data)                  → producer; contributes that path
a call carrying only path keys            → reader (read/glob/grep/list); nothing
str_replace_editor with command != "view" → contributes its `path`
anything else                             → nothing
```

Why the pivot: the name allowlist (`write`/`edit`/`str_replace_editor`/`bash`) was drafted first, but two facts killed it. First, the platform is going multi-harness — Claude Code spells it `Write`, Gemini `write_file`, dsh `write` — and an allowlist drops a harness silently the day it is added, which is precisely the failure mode this change exists to fix. Second, this repo's own e2e seeded a fictional `write_file` shape and only the strip's key-scan kept it green — evidence that names drift even inside one repo. The shape rule admits any writer whose call hands over content for a path, and keeps readers out because readers carry no content. Default-deny survives in the sense that matters: nothing is reported unless the call either declares an output (a command string) or supplies content for a path.

The original alternatives considered still stand: (a) keep scanning argument keys and result text with no dispatch — rejected, it violates the strip's own requirement ("produced or modified") and is the bug being fixed; (b) denylist the readers — rejected, fails open for every tool added later.

`findFilePath` (the old key-scan-plus-result-scan function) was removed rather than kept beside the new rule — the same single-door discipline the sibling change applied to `linkRef`. Its result-text scan was the false-positive mechanism; leaving it exported would invite the next caller back onto it.

**Decision: a shell call's candidates come from the command string, gated by an output signal.**

Two signals admit a candidate:

1. **Redirection** — the token after `>` or `>>`.
2. **A producing verb** — `zip`, `tar`, `gzip`, `7z`, `rar`, `cp`, `mv`, `rsync`, `pandoc`, `ffmpeg`, `convert`, `soffice`, `dd`, `split` — in which case the command's path-shaped tokens are candidates.

A command matching neither contributes nothing, so `ls -la`, `curl …`, `git status`, `sed -n '1,40p' f`, and `wc -c < f` all contribute nothing. Alternatives considered: (a) scan every command's tokens — rejected, it re-admits read noise (`sed -n '1,40p' count.txt` would contribute `count.txt`); (b) require redirection only — rejected, `zip -r bundle.zip src/` is the reported case and does not redirect.

The result text is **not** scanned for candidates. It was the source of the false positives, and a command's output naming a file is not evidence the command made it.

**Decision: candidates resolve against the workspace root, with no `cd` tracking.**

A candidate is taken literally and resolved from the workspace root; a candidate that escapes the root (leading `../` that leaves it) is dropped. `cd out && zip -q ../bundle.zip *` therefore yields nothing — the archive's real location depends on a directory that exists only inside the command. Alternatives considered: parse `cd` and track a working directory per command segment — rejected as a shell interpreter in disguise, with a long tail (`cd -`, subshells, `&&`/`;`/`|` boundaries) far beyond the benefit; the sampled transcripts contain zero archive commands, so the frequency of this form is unproven. Recorded as a known limitation.

**Decision: existence is validated by the lookup the strip already performs.**

Candidates beyond the first are fed to the same batched lookup; the strip's existing filter drops `missing`/`invalid`. Client-side cap of 20 candidates per turn to match the server's `LOOKUP_MAX_PATHS`, so a pathological command cannot truncate a real artifact off the list. This needs no server change.

**Decision: the shared extension table gains archive and compression types.**

`tar`, `gz`, `tgz`, `7z`, `rar`, `bz2`, `xz` are added to `FILE_EXTENSIONS` (and the extraction regex's extension alternation), so both clients recognize them. `extOf` takes the final extension, so `.tar.gz` resolves as `gz`. Adding them to the *broad* table is right: these are produced files with no renderer, exactly the case the broad table exists for.

## Risks / Trade-offs

- **A producer's input can still be reported as a product.** `zip -r bundle.zip src/a.txt` names both; `src/a.txt` exists, so the lookup admits it and the strip lists an input. → Accepted for v1: distinguishing input from output needs content or mtime evidence the server cannot supply yet. Mitigated in the common case by the verb list (the archive is named, and `src/`-style directories are dropped by the existence check since directories are not files).
- **A producing verb used for a read.** `cp`/`convert` on an input also names the input. Same root cause as above, same acceptance.
- **A candidate whose path is real but outside the workspace** is dropped by resolution. The strip's contract is workspace-scoped, so this is correct rather than lossy.
- **Under-reporting is now possible where over-reporting was the norm.** A shell command producing a file through a verb not on the list (`make bundle`) contributes nothing; before this change its output text might have been scanned. → Accepted: silent omission is the failure the strip already tolerates (it is a best-effort synthesis), whereas a wrong entry misleads. The verb list is one constant to extend when a real case appears.
- **`bash` is one tool name with several implementations** (foreground, persistent, and the pwsh sibling). Mooted by the shape pivot: the rule keys on the `command` argument's presence, not the tool's name, so every variant contributes identically. Verified against the shipped packages (all carry `command`).

## Migration Plan

Client-side only, shipped with the web bundle and the shared core module: no server deploy, no data migration, no version skew (the lookup endpoint it calls is unchanged and already in use). Rollback is reverting the client change. Historical sessions re-render under the new rule — that is the strip's existing contract (render-time synthesis, identical for historical sessions), and it is a correction, not a regression: a past turn that only read files will stop showing a strip.
