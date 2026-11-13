## MODIFIED Requirements

### Requirement: Manifest validation and limits

The publish endpoint SHALL validate the manifest shape and reject invalid publishes with a machine-readable reason: skill entries SHALL have well-formed unique names and bounded content; a skill entry MAY carry an auxiliary file set (relative path to text content) and a stored frontmatter object, admitted under the platform's package contract — paths that escape the skill directory, non-text file kinds, file names colliding with the rendered skill document under case-insensitive filesystems, an auxiliary file beyond the per-file bound, or an aggregate beyond the per-skill bound (file count or total size) are each rejected naming the offending entry; MCP entries SHALL be registry-name references only (any endpoint URL or command config SHALL be rejected); agent entries SHALL be persona-only (any endpoint, model, or credential reference SHALL be rejected) and their ids SHALL NOT fall under the `user.` prefix (reserved for the cell's custom presets — openspec: custom-presets); an agent entry's resource declaration SHALL name only skills and MCP references that the same manifest declares, with no duplicated names within one declaration (violations SHALL be rejected naming the role and entry); the manifest as a whole SHALL stay within per-pack size and count limits. A manifest MAY carry an optional top-level `notes` field — a string of at most 500 characters serving as the human-readable version note; a `notes` value that is not a string or exceeds the limit SHALL be rejected with a reason naming the field. Once published, the note is part of the immutable version (openspec: pack-marketplace, Published versions are immutable). The cell's install path SHALL enforce the same rules on the manifest it receives.

Every rejection SHALL identify the offending location in a form the creating surface can turn into a jump target (a field path or entry name), and the creating surface SHALL render the refusals as locatable rows rather than one summary sentence. The rejection conditions themselves SHALL NOT change: the checklist presentation is the same gate, not a second one, and a refusal added by a new gate SHALL appear in the list without any other change.

#### Scenario: MCP entry with an endpoint URL is rejected

- **WHEN** a publish contains an MCP entry carrying a `url` or command config
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Agent entry with an endpoint is rejected

- **WHEN** a publish contains an agent entry carrying `baseUrl`, `model`, or `apiKeyEnv`
- **THEN** the publish is rejected with a reason naming the offending entry

#### Scenario: Oversized skill is rejected

- **WHEN** a publish contains a skill body exceeding the per-skill content limit
- **THEN** the publish is rejected with a reason naming the offending skill

#### Scenario: Path-escaping auxiliary file is rejected

- **WHEN** a publish contains a skill entry whose auxiliary file set carries a path with `..` segments or an absolute path
- **THEN** the publish is rejected with a reason naming the offending skill and path

#### Scenario: Oversized auxiliary file is rejected

- **WHEN** a publish contains a skill entry with an auxiliary file beyond the per-file size bound
- **THEN** the publish is rejected with a reason naming the offending skill and file

#### Scenario: Auxiliary aggregate bound is enforced

- **WHEN** a publish contains a skill entry whose auxiliary file set exceeds the per-skill file-count or total-size bound
- **THEN** the publish is rejected with a reason naming the offending skill and the exceeded bound

#### Scenario: Skill-document name collision is rejected

- **WHEN** a publish contains a skill entry whose auxiliary file set carries a file whose name is a case variant of the skill document's own name
- **THEN** the publish is rejected with a reason naming the offending skill and file

#### Scenario: Role declaration naming an undeclared resource is rejected

- **WHEN** a publish contains an agent entry whose resource declaration names a skill or MCP reference not present in the manifest's own lists
- **THEN** the publish is rejected with a reason naming the role and the unknown name

#### Scenario: Duplicated declaration entry is rejected

- **WHEN** a role's resource declaration lists the same skill or MCP name twice
- **THEN** the publish is rejected with a reason naming the role and the duplicate

#### Scenario: Reserved-prefix agent id is rejected

- **WHEN** a publish contains an agent entry whose id starts with `user.`
- **THEN** the publish is rejected with a reason naming the entry and the reserved namespace

#### Scenario: Oversized version notes are rejected

- **WHEN** a publish carries a `notes` value longer than 500 characters
- **THEN** the publish is rejected with a machine-readable reason naming the `notes` field, and nothing is stored

#### Scenario: Non-string version notes are rejected

- **WHEN** a publish carries a `notes` value that is not a string
- **THEN** the publish is rejected with a machine-readable reason naming the `notes` field, and nothing is stored

#### Scenario: Notes are optional

- **WHEN** a publish carries no `notes` field
- **THEN** the publish proceeds exactly as before, and the version renders with no note

#### Scenario: Every refusal is locatable

- **WHEN** a publish is refused for two independent violations
- **THEN** the response carries both with their offending field paths or entry names, and the creating surface can render them as two rows

#### Scenario: Presentation cannot relax the gate

- **WHEN** the creating surface shows no pending items and the server still refuses
- **THEN** the refusal stands and names its location; the surface must surface that row rather than reporting success

#### Scenario: A new gate appears in the list without special-casing

- **WHEN** a publish is refused by a gate added after this change
- **THEN** its refusal is rendered with the same locatable shape, and nothing else in the surface changes
