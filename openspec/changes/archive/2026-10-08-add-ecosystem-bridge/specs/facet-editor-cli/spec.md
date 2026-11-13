# facet-editor-cli Specification (Delta)

## MODIFIED Requirements

### Requirement: Skills install into editor targets

The `@finddatatechnology/facet` CLI SHALL install a published pack's skills from the facet service into supported editor targets — Claude Code, Cursor, ZCode, Codex, and Gemini CLI — each target using its native skill layout (user-level by default, project-level where the target supports it). Installing SHALL write each skill's content with its name and description metadata, taken from the referenced pack version's snapshot.

#### Scenario: Claude Code user-level install

- **WHEN** a user runs the CLI with a pack reference and the Claude Code target
- **THEN** each skill of the pack appears in the user-level skills directory with its content and metadata

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

The CLI and the download face SHALL present a pack's MCP references with their real connection endpoint and an explicit notice of the credential requirement. Without a caller key on file, the CLI SHALL NOT write MCP connection configuration into any editor target. With a caller key established through the connect flow, the CLI SHALL offer to write each target's native MCP configuration — endpoint plus Authorization header carrying that key — for the pack's MCP references, and SHALL say exactly which files it wrote.

#### Scenario: MCP reference prints endpoint and notice

- **WHEN** an installed pack declares MCP references and no caller key is on file
- **THEN** the CLI output lists each server's connection endpoint with a notice that connecting requires a caller key
- **AND** no editor MCP configuration file is created or modified

#### Scenario: Connected install writes MCP configuration

- **WHEN** a pack with MCP references is installed while a verified caller key is on file and the user accepts the write
- **THEN** the target's native MCP configuration gains an entry per referenced server with the gateway endpoint and the key-bearing Authorization header
- **AND** the CLI reports every file it wrote

## ADDED Requirements

### Requirement: Connect walkthrough mints and verifies a caller key

The CLI SHALL provide a `connect` flow that establishes a caller key: it guides the user to the web mint surface (opening the browser), accepts the pasted key in the v1 form, and progresses to a device-authorization form (CLI polls, no paste) when the registry exposes it. The flow SHALL verify the key's liveness against the gateway before storing it locally for CLI use, refuse invalid or revoked keys with the reason, and support clearing the stored key.

#### Scenario: Pasted key is verified and remembered

- **WHEN** a user completes connect by pasting a freshly minted key and the key authenticates on the gateway
- **THEN** the CLI stores it locally, reports the owning identity's visible servers, and subsequent installs use it for MCP configuration writes

#### Scenario: Dead key is refused at connect

- **WHEN** the pasted key fails liveness (revoked, malformed, or gateway-rejected)
- **THEN** connect fails with the reason and nothing is stored

#### Scenario: Device flow replaces the paste

- **WHEN** the registry exposes device authorization and the user runs connect
- **THEN** the CLI completes the mint without any manual paste and the stored key behaves identically
