# pack-authoring — Delta

## MODIFIED Requirements

### Requirement: Skills are composed inline

Each draft skill entry SHALL carry a name, a description, and the full skill body, edited with the same conventions as the platform's custom skills. An entry MAY additionally carry an auxiliary file set (a mapping of relative paths to text contents) and a stored frontmatter object — a package-shaped skill. The editor SHALL validate skill-name format and per-entry size limits (body, auxiliary files, frontmatter together) before a publish can be submitted, and SHALL reject auxiliary paths that escape the skill directory, non-text file kinds, and file names that collide with the rendered skill document under case-insensitive filesystems. An entry without auxiliary files and frontmatter behaves exactly as the single-file skill of the previous contract.

#### Scenario: Author writes a skill body

- **WHEN** the author adds a skill entry with name, description, and body and saves the draft
- **THEN** the entry persists and is listed in the editor with its body editable

#### Scenario: Malformed skill name is caught before publish

- **WHEN** the author enters a skill name with characters outside the allowed format and attempts to publish
- **THEN** the editor blocks the publish and names the offending entry

#### Scenario: Author uploads a package into a draft entry

- **WHEN** the author uploads a skill package (zip) into a draft skill entry
- **THEN** the package is parsed server-side under the platform's package contract (path safety, text-only admission, per-file and per-skill bounds), the entry receives the parsed body and auxiliary file set, and the editor shows the file inventory
- **AND** a package that violates the contract is rejected with a reason naming the offending file or limit

#### Scenario: Author imports an installed multi-file skill into a draft

- **WHEN** the author imports a locally installed skill that carries auxiliary files
- **THEN** the draft entry carries the skill's body, auxiliary file set, and stored frontmatter

## ADDED Requirements

### Requirement: Draft entries carry package content uniformly

A draft skill entry's auxiliary file set and frontmatter SHALL be part of the draft's persisted state regardless of how the entry was created — written by hand, uploaded as a package, imported from an installed skill, or produced by the preset-prefill conversion. Every path that inlines one of the author's own skills into a draft SHALL carry that skill's full stored shape (body, auxiliary files, frontmatter), so a multi-file skill survives the journey into a pack draft without silent loss.

#### Scenario: Prefill from a custom preset keeps files

- **WHEN** the author runs the preset-to-draft conversion and the preset references one of the author's multi-file skills
- **THEN** the resulting draft entry carries that skill's body and its auxiliary file set

#### Scenario: Draft persists files across edit sessions

- **WHEN** the author saves a draft whose entry carries files, closes the editor, and reopens the draft
- **THEN** the entry's file inventory and contents are intact
