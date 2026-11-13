## ADDED Requirements

### Requirement: Installed external skills can be explicitly updated

The platform SHALL offer an explicit update action for a skill installed from an external source (a skill carrying external provenance with an origin URL). Triggering it SHALL fetch the current upstream package server-side (the browser SHALL NOT download external artifacts) and present a content-diff summary — per-file added / changed / removed plus an overall content-hash comparison — before any write. Only an explicit user confirmation SHALL replace the installed skill's stored content and materialized files, reusing the existing reinstall-replace semantics (the same source and slug own the name) and the existing materialization + hot-reload path, so the updated skill becomes live without a runtime restart. A failed, unreachable, or cancelled update SHALL leave the previously installed snapshot untouched (stale-on-failure). The platform SHALL NOT auto-check for updates, poll upstream, or follow versions in the background; update fetches occur only on explicit user action.

#### Scenario: update previews a diff before any write

- **WHEN** a signed-in user triggers the update action on an installed external skill
- **THEN** the server fetches the current upstream package and returns a per-file diff summary (added / changed / removed) without writing anything
- **AND** the UI presents the summary for confirmation

#### Scenario: confirmed update replaces in place and hot-reloads

- **WHEN** the user confirms the update after reviewing the diff
- **THEN** the skill's stored content and materialized files are replaced and re-materialized through the watched-directory path
- **AND** the updated skill is invocable without a runtime restart
- **AND** its provenance (origin URL, upstream-declared version) is refreshed

#### Scenario: upstream failure keeps the installed snapshot

- **WHEN** the upstream fetch fails during preview or confirmed update (404 / deleted source / network failure)
- **THEN** the action fails with an explicit error naming the cause
- **AND** the previously installed skill's content and files remain unchanged

#### Scenario: no background update activity

- **WHEN** no user triggers the update action
- **THEN** the platform performs no upstream fetches, polling, or version checks for installed external skills
