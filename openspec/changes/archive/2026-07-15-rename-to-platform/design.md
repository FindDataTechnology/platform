## Context

The codebase hardcodes the product name "pi-web-chat" across ~11 locations spanning user-facing UI strings, machine-facing client identifiers, package metadata, and documentation. There is no single source of truth for the product name today - each surface holds its own literal. The rename to "Platform" must update every surface consistently; a partial rename would leave mixed identity (e.g., the browser title says "Platform" while the MCP client still identifies as "pi-web-chat").

The project is a greenfield, no-build, ESM Node app with no test runner or linter, so verification is by grep + a manual run, not automated tests.

## Goals / Non-Goals

**Goals:**
- Every identity surface presents a single consistent name: "Platform" for user-facing display and "platform" for machine-facing identifiers and the npm package name (lowercase per npm convention).
- The rename is complete - no stale "pi-web-chat" references remain in source, configs, or specs.

**Non-Goals:**
- Renaming anything beyond product-identity strings. The WebSocket protocol, REST routes, MCP tool namespacing (`mcp__<server>__<tool>`), provider names, file names, and directory names (`knowledge-store/`, `skills/`) are unchanged.
- Renaming the `@earendil-works/pi-*` SDK dependencies or the `pi-provider-litellm` extension - "pi" there refers to the underlying SDK, not the product.
- Introducing a centralized name constant/config. Each surface keeps its own literal; a shared constant is out of scope because the surfaces are few and heterogeneous (HTML, JSON, log strings, HTTP headers).
- Changing the repo's working-directory name or git history.

## Decisions

**Decision 1: Display name "Platform", machine/package name "platform".**
npm package names must be lowercase; HTTP User-Agent and MCP client names are conventionally lowercase tokens. The user-facing title/heading uses the capitalized "Platform". This matches npm convention and avoids a capitalized package `name` that some tooling rejects.
- Alternative considered: use "Platform" verbatim everywhere. Rejected - npm lowercases package names and a capitalized `name` is non-idiomatic.

**Decision 2: Update `package-lock.json` `name` fields by hand, not via `npm install`.**
The lockfile stores the package `name` in two places (root object + the top-level project entry). Editing them directly is deterministic and keeps the diff minimal. `npm install` would also work but may reorder unrelated lockfile content.
- Alternative considered: run `npm install` to let npm regenerate. Rejected to keep the diff focused.

**Decision 3: Route the `open-connector-ui` spec reference through a MODIFIED requirement delta.**
The spec text references "pi-web-chat's proxy". Per the spec-driven workflow, spec text changes flow through delta specs and are merged via `/opsx:sync`, not by editing the main spec during apply. This keeps the change auditable.
- Alternative considered: edit `openspec/specs/open-connector-ui/spec.md` directly during apply. Rejected - it bypasses the delta/audit mechanism this repo uses.

**Decision 4: Leave `pi-provider-litellm` / `@earendil-works/pi-*` names untouched.**
These "pi" tokens refer to the underlying pi SDK and the litellm provider extension, not the product. Renaming them would break dependency resolution and provider registration. Only product-identity strings change.

## Risks / Trade-offs

- [Partial rename leaves mixed identity] -> Mitigation: after edits, grep the repo for `pi-web-chat` (case-insensitive) and confirm zero hits in source/configs/main specs. Remaining hits are acceptable only inside archived change artifacts (`openspec/changes/archive/`) and historical change folders, which are immutable records.
- [External system cached the old MCP client name / User-Agent] -> Mitigation: low impact - the MCP client name is informational (server logs / MCP handshake) and the User-Agent is sent only by the knowledge URL fetcher. No auth or routing depends on either. Acceptable.
- [Lockfile drift from hand-editing] -> Mitigation: edit only the two `name` fields; do not touch dependency entries. Validate with `npm ls` afterward.

## Migration Plan

1. Apply string edits across the 9 files (enumerated in tasks.md).
2. Update the `package-lock.json` `name` fields.
3. Grep-verify no stale `pi-web-chat` references remain outside archived/historical change artifacts.
4. `npm install` (no-op expected) and `npm start`; confirm the browser title reads "Platform" and the startup log reads `Platform running at ...`.

Rollback: revert the commit. No persistent or runtime state is affected - the rename touches no `knowledge-store/` data or runtime state.

## Open Questions

None. The new name ("Platform") and the lowercase-machine / capitalized-display split are decided. If a different display capitalization or distinct package name is preferred, it is a one-line adjustment per surface.
