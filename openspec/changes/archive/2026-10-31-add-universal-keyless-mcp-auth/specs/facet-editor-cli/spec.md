## MODIFIED Requirements

### Requirement: MCP references are honest about credentials

The CLI and the download face SHALL present a pack's MCP references with their real connection endpoint and an explicit notice of the credential requirement, and SHALL select the connection lane for a target from the machine-verified capability table rather than from documentation.

Three lanes exist:

- **Native OAuth** — a pre-registered static client identifier is written and the client performs authorization itself; nothing secret enters the file. Written only when the target's capability record evidences that the client consumes a static client identifier.
- **Brokered token** — the CLI completes the authorization flow and writes a short-lived access token into the target's static `Authorization` header. This lane requires no client-side OAuth support and SHALL be the default where the client honours static headers but does not consume a static client identifier.
- **Caller key** — the device-flow key established by the connect flow, retained for headless and scripted use.

Without any credential on file and without an explicit lane request, the CLI SHALL NOT write MCP connection configuration into any editor target. With a credential established, the CLI SHALL offer to write each target's native MCP configuration and SHALL say exactly which files it wrote and which lane it used.

For the WorkBuddy target the native configuration SHALL be the client's own MCP file at user level (`~/.workbuddy/mcp.json`) and at project level (`<project>/.workbuddy/mcp.json`). As of WorkBuddy 5.9.3 its user-file loader drops the `oauth` block, so the brokered-token form is the working lane for this target and the native-OAuth form SHALL NOT be presented as working there until the capability record evidences otherwise.

#### Scenario: MCP reference prints endpoint and notice

- **WHEN** an installed pack declares MCP references and no credential is on file
- **THEN** the CLI output lists each server's connection endpoint with a notice that connecting requires an authorization
- **AND** no editor MCP configuration file is created or modified

#### Scenario: Connected install writes MCP configuration

- **WHEN** a pack with MCP references is installed while a verified credential is on file and the user accepts the write
- **THEN** the target's native MCP configuration gains an entry per referenced server with the gateway endpoint and a bearer credential
- **AND** the CLI reports every file it wrote and the lane it selected

#### Scenario: WorkBuddy MCP write uses the client's own files and shape

- **WHEN** a connection is written for WorkBuddy
- **THEN** the entry is written into `~/.workbuddy/mcp.json` at user level, or `<project>/.workbuddy/mcp.json` when a project directory is named
- **AND** the entry carries `type: "http"`, the gateway `url`, and an `Authorization` header
- **AND** no other client's configuration file is touched

#### Scenario: WorkBuddy keyless write carries no credential

- **WHEN** a native-OAuth write is requested for WorkBuddy on a client build whose capability record says the user-file loader does not consume the OAuth block
- **THEN** the CLI refuses that lane for this build and names the brokered-token lane as the working alternative
- **AND** if the record later evidences that the block is consumed, the same write proceeds carrying `oauth.clientId` and `oauth.scope` with no Authorization header or other secret

#### Scenario: Keyless opt-in declined on unverified targets

- **WHEN** a native-OAuth write is requested for a target with no capability record or a stale one
- **THEN** the CLI refuses with an explanation naming the verified targets and points to the brokered-token and caller-key lanes
- **AND** no configuration file is created or modified

#### Scenario: Brokered token is short-lived and does not carry a refresh token

- **WHEN** the CLI writes a brokered token into a target's configuration
- **THEN** the written value is an access token with its expiry reported to the user, no refresh token is written, and the file's permissions are restricted so that only the owner can read it

#### Scenario: Native OAuth lane is only offered where evidenced

- **WHEN** a native-OAuth write is requested for a target
- **THEN** the write proceeds only if the target's capability record evidences that the client consumes a static client identifier; otherwise the CLI refuses with an explanation naming the brokered-token and caller-key alternatives and writes nothing

#### Scenario: Credential expiry is renewable in one step

- **WHEN** the stored credential has expired
- **THEN** a single refresh action renews it and rewrites the target's configuration, or — absent a refresh token — re-authorizes in one step, and the CLI reports which of the two happened

### Requirement: Skills install into editor targets

The `@finddatatechnology/facet` CLI SHALL install a published pack's skills from the facet service into supported editor targets — CC, Cursor, ZCode, Codex, Gemini CLI, and WorkBuddy — each target using its native skill layout (user-level by default, project-level where the target supports it). Installing SHALL write each skill's content with its name and description metadata, taken from the referenced pack version's snapshot. Installing SHALL NOT require any credential and SHALL NOT depend on the target's MCP authorization behaviour.

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
