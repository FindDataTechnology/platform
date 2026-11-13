## MODIFIED Requirements

### Requirement: Skills install into editor targets

The `@finddatatechnology/facet` CLI SHALL install a published pack's skills from the facet service into supported editor targets — Claude Code, Cursor, ZCode, Codex, Gemini CLI, and WorkBuddy — each target using its native skill layout (user-level by default, project-level where the target supports it). Installing SHALL write each skill's content with its name and description metadata, taken from the referenced pack version's snapshot.

#### Scenario: Claude Code user-level install

- **WHEN** a user runs the CLI with a pack reference and the Claude Code target
- **THEN** each skill of the pack appears in the user-level skills directory with its content and metadata

#### Scenario: WorkBuddy install lands in its native layout

- **WHEN** a user runs the CLI with a pack reference and the WorkBuddy target
- **THEN** each skill of the pack is written as its own directory containing a `SKILL.md` under that client's native skills location, user-level by default and project-level when a project directory is named
- **AND** the CLI reports the paths it wrote

#### Scenario: Project-level install

- **WHEN** the install names a project directory
- **THEN** skills are written into that project's layout instead of the user-level directory

#### Scenario: Unsupported target is refused with guidance

- **WHEN** the CLI is asked to install to a target it does not support
- **THEN** it refuses with a message listing the supported targets, and writes nothing

#### Scenario: Unknown pack reference errors

- **WHEN** the CLI is given a pack reference that does not resolve to a published pack
- **THEN** it exits with an error naming the reference, and writes nothing

### Requirement: MCP references are honest about credentials

The CLI and the download face SHALL present a pack's MCP references with their real connection endpoint and an explicit notice of the credential requirement. Without a caller key on file, the CLI SHALL NOT write key-bearing MCP connection configuration into any editor target; the keyless OAuth form is written only when the user explicitly opts in (`--oauth`) and only against a target whose OAuth behavior is verified. With a caller key established through the connect flow, the CLI SHALL offer to write each target's native MCP configuration — endpoint plus Authorization header carrying that key — for the pack's MCP references, and SHALL say exactly which files it wrote.

For the WorkBuddy target the native configuration SHALL be the client's own MCP file at user level (`~/.workbuddy/mcp.json`) and at project level (`<project>/.workbuddy/mcp.json`). Two connection forms are supported against this target: the key-bearing form (`type: "http"`, gateway `url`, `headers.Authorization`), and, when the user explicitly opts in (`--oauth`, optionally `--oauth-client <id>`), a credential-free form declaring the pre-registered static OAuth client (`type: "http"`, gateway `url`, `oauth.clientId`, `oauth.scope`). The static-client lane was verified end-to-end against our gateway (authorize → token → 200 → tools listed); the key-bearing form is the working path when the target client does not yet consume the oauth block — as of WorkBuddy 5.9.3 its user-file loader drops it (only connector/marketplace-template items honor `oauth.clientId`), and the CLI SHALL say which lane is live for the target instead of implying authorization will complete unattended. A keyless request against a target whose OAuth behavior has not been verified SHALL be refused with an explanation, writing nothing.

#### Scenario: MCP reference prints endpoint and notice

- **WHEN** an installed pack declares MCP references and no caller key is on file
- **THEN** the CLI output lists each server's connection endpoint with a notice that connecting requires a caller key
- **AND** no editor MCP configuration file is created or modified

#### Scenario: Connected install writes MCP configuration

- **WHEN** a pack with MCP references is installed while a verified caller key is on file and the user accepts the write
- **THEN** the target's native MCP configuration gains an entry per referenced server with the gateway endpoint and the key-bearing Authorization header
- **AND** the CLI reports every file it wrote

#### Scenario: WorkBuddy MCP write uses the client's own files and shape

- **WHEN** a connected install targets WorkBuddy
- **THEN** the entry is written into `~/.workbuddy/mcp.json` at user level, or `<project>/.workbuddy/mcp.json` when a project directory is named
- **AND** the entry carries `type: "http"`, the gateway `url`, and `headers.Authorization` with the caller key
- **AND** no other client's configuration file is touched

#### Scenario: WorkBuddy keyless write carries no credential

- **WHEN** an install with `--oauth` targets WorkBuddy and the user accepts the write, whether or not a caller key is on file
- **THEN** the entry carries `type: "http"`, the gateway `url`, and a static OAuth client (`oauth.clientId` + `oauth.scope`) — and carries no Authorization header or other secret
- **AND** the CLI states the lane's real status for this client version (server lane verified; the 5.9.3 user-file loader does not yet consume the block — the key-bearing form is today's working path)
- **AND** `--oauth-client <id>` overrides the client id when a deployment registers its own application

#### Scenario: Keyless opt-in declined on unverified targets

- **WHEN** `--oauth` is combined with a target whose OAuth behavior has not been verified
- **THEN** the CLI refuses with an explanation naming the verified targets and points to the caller-key flow
- **AND** no configuration file is created or modified
