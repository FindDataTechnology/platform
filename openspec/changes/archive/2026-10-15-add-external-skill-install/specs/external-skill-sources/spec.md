## REMOVED Requirements

### Requirement: External shelf is read-only
**Reason**: Superseded by this change. The 刀一 boundary ("no install path; content entering the runtime is a later change") was a deliberate staging decision, not a permanent product stance: discovery shipped first, installation ships now with its own governance surface (informed consent + server-side enforcement). Keeping this requirement would contradict the install capability added below.
**Migration**: The shelf remains browse-only by default — installation exists solely as an explicit, per-entry, user-confirmed action (see "External skill installation requires informed consent (server-enforced)" below). Existing shelf behavior (search, grouping, provenance marks, snapshot cache) is unchanged; no stored data or API shape from 刀一 is migrated or altered.

## ADDED Requirements

### Requirement: External skill installation from the shelf

The platform SHALL allow a signed-in user to install an external-shelf entry as a local custom skill through a server-side install endpoint keyed by `(source, slug)`. Installation SHALL fetch the package server-side (the browser SHALL NOT download external artifacts), unpack it, and write it through the existing custom-skill path (database row + materialization) so the installed skill becomes available to the agent like any other custom skill. A successfully installed skill SHALL record its external provenance (source id, upstream origin URL, original upstream name/version) in a form readable back through the skills listing. Reinstalling an entry that was previously installed from the same source SHALL replace that skill's content; attempting to install onto a conflicting name not owned by this install path SHALL fail with an explicit error and SHALL NOT overwrite the existing skill.

#### Scenario: install a skill from the shelf

- **WHEN** a signed-in user confirms installation of a shelf entry (source `skillhub`, slug `pdf-image-text-extractor`)
- **THEN** the server fetches the package server-side, stores the skill, materializes it into the watched directory, and returns a success result naming the installed skill
- **AND** the installed skill appears in the installed-skills listing with its external source provenance

#### Scenario: browser never downloads external artifacts

- **WHEN** any installation is performed
- **THEN** the package bytes are fetched by the server; the browser only calls the platform's own preview/install endpoints

#### Scenario: stale upstream fails closed

- **WHEN** the entry's package cannot be fetched (upstream 404/deleted repository/network failure)
- **THEN** the install request fails with an explicit error naming the cause, and no skill row or materialized file is created

#### Scenario: conflicting name is not overwritten

- **WHEN** the normalized name of the entry to install collides with an existing skill not owned by a previous install of the same entry
- **THEN** the server responds with a conflict error and the existing skill is left untouched

#### Scenario: reinstall replaces the owned skill

- **WHEN** the user reinstalls an entry whose skill was installed earlier from the same `(source, slug)`
- **THEN** that skill's stored content and files are replaced with the freshly fetched package

### Requirement: External skill installation requires informed consent (server-enforced)

Installing an external skill SHALL require that the user first received a preview of what will be installed and then explicitly confirmed it. The server SHALL expose a preview operation returning, for the entry: the skill body (or a bounded excerpt), the full package file list, which files are executable-content (scripts and similar), the license state and text as mirrored, and the upstream origin URL. The install operation SHALL require a confirmation marker in the request; a request without it SHALL be rejected and SHALL NOT install anything. The preview and install responses SHALL carry the "not reviewed by this platform" posture forward — an installed external skill SHALL remain distinguishable from platform-reviewed content.

#### Scenario: preview precedes install

- **WHEN** a signed-in user opens the install flow for a shelf entry
- **THEN** the preview operation returns the body excerpt, the file list, the script-file inventory, the license state, and the upstream URL before any install request is sent

#### Scenario: unconfirmed install is refused server-side

- **WHEN** an install request arrives without the explicit confirmation marker (e.g. a direct API call bypassing the UI)
- **THEN** the server rejects the request with an explanatory error and installs nothing

#### Scenario: script-bearing skill highlights scripts in the preview

- **WHEN** the package contains files classified as executable content (e.g. `.py`/`.sh`/`.js` scripts)
- **THEN** the preview's file inventory marks those files, and the confirmation requirement is present regardless of whether the user's client would have shown it

#### Scenario: no install affordance for a disabled source

- **WHEN** a source is disabled via `EXTERNAL_SKILL_SOURCES`
- **THEN** preview/install for that source's entries resolve to not-found, and the shelf never offers the flow for them

### Requirement: Multi-file packages are stored and materialized as directory trees

An installed external skill SHALL support packages containing more than one file: the SKILL.md document plus auxiliary files (scripts, references, metadata). The stored record SHALL carry the auxiliary file set alongside the skill body, and materialization SHALL write the complete directory tree for the skill so that the runtime's skill resources resolve against the skill's own directory. Package extraction SHALL be bounded and safe: path-traversal entries (absolute paths, `..` segments) SHALL be rejected, and extraction SHALL enforce per-file size, total auxiliary size, file-count, unpacked-size, and body-length bounds — a package exceeding an aggregate bound SHALL fail the install rather than truncating silently, and an individual file exceeding the per-file bound SHALL be omitted from storage while remaining listed in the preview. Non-text/binary auxiliary files MAY be omitted from storage; when omitted, the preview SHALL have listed the package honestly (omission is visible, never silent).

#### Scenario: multi-file package installs completely

- **WHEN** a SkillHub package containing `SKILL.md`, `scripts/*.py` and `_meta.json` is installed
- **THEN** the materialized skill directory contains the SKILL.md and the stored auxiliary files, and the skill's resource base resolves to that directory

#### Scenario: traversal entries are rejected

- **WHEN** a package contains an entry whose path escapes the package root (absolute path or `..` segments)
- **THEN** the install fails with an explicit error and nothing from that package is written

#### Scenario: aggregate bounds fail rather than truncate

- **WHEN** a package exceeds the configured aggregate bounds (total auxiliary size, auxiliary file count, unpacked size, or body length)
- **THEN** the install fails with an explicit limit error

#### Scenario: an oversized single file is omitted visibly

- **WHEN** one package file exceeds the per-file size bound
- **THEN** that file is omitted from storage and remains listed in the preview as omitted-for-size, and the install proceeds with the remaining files

#### Scenario: single-file packages keep working

- **WHEN** a package contains only a SKILL.md
- **THEN** the installed skill materializes exactly as before (one file, same layout)

### Requirement: External skills are name-normalized to the runtime's grammar

The runtime's skill-name grammar is `^[a-z0-9]+(-[a-z0-9]+)*$`, and a skill whose name does not match is silently ignored at load time. Installation SHALL normalize external names into that grammar (lowercase; disallowed characters folded to hyphens; repeated/edge hyphens collapsed). The installed skill's platform name SHALL be the normalized form, and the original upstream name SHALL be preserved in the stored provenance and shown to the user — normalization SHALL NOT hide what the upstream entry is called.

#### Scenario: uppercase/underscore upstream name is normalized

- **WHEN** an entry's upstream name contains uppercase letters or underscores
- **THEN** the installed skill's name matches the runtime grammar and would be discovered by the skill loader (not silently ignored)
- **AND** the original upstream name remains visible in the skill's provenance/description

#### Scenario: name that normalizes to empty is refused

- **WHEN** an entry's upstream name contains no characters surviving normalization
- **THEN** the install fails with an explicit error instead of installing an unnamed skill

### Requirement: External package fetch is per-source and fail-closed

Each source's package retrieval SHALL follow that source's verified mechanism: for SkillHub, the market's download endpoint (a zip artifact); for Smithery, the contents of the entry's upstream repository directory (fetched file-by-file from the repository's public contents API, scoped to the entry's subdirectory, resolving any symlinked intermediate path segments and failing closed on any that escapes the repository). Retrieval SHALL use the same outbound discipline as the read-only shelf (credential-free, bounded timeout, platform user agent), and SHALL NOT follow upstream redirects to non-allowlisted hosts beyond the market/repository/CDN hosts verified for that source. Any failure at fetch, unpack, or validation SHALL abort the install with an explicit reason and leave the platform state untouched.

#### Scenario: skillhub package comes from the download endpoint

- **WHEN** installing a SkillHub entry
- **THEN** the server retrieves the market's zip download for that slug and unpacks it server-side

#### Scenario: smithery package comes from the upstream repository subdirectory

- **WHEN** installing a Smithery entry whose `gitUrl` points at a directory inside a repository
- **THEN** the server retrieves that directory's contents from the upstream repository (following symlinked path segments within the repository) and assembles the skill package from them

#### Scenario: upstream moved or deleted

- **WHEN** a Smithery entry's `gitUrl` directory no longer exists upstream
- **THEN** the install fails with an explicit upstream-not-found error naming the origin URL, and no partial skill is written
