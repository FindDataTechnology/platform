# facet-editor-cli Specification

## Purpose
多编辑器安装面：让没有壹座账号的编辑器用户（Claude Code、Cursor 等）以最低摩擦获取功能集内容——CLI 装技能、下载面取原文，MCP 引用如实标注凭据要求（v1 不写 MCP 配置）。

## Requirements

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

### Requirement: Download face serves editor-neutral content

The facet service SHALL serve for any public pack version: every skill's body as raw markdown with synthesized frontmatter, and the full manifest (skills, MCP references with required groups, agent personas) — all fetchable without an account.

#### Scenario: Skill body downloads without an account

- **WHEN** an anonymous user fetches a public pack's skill route
- **THEN** the raw markdown returns with no credential required

#### Scenario: Manifest inspection without an account

- **WHEN** an anonymous user opens a public pack's detail on the facet domain
- **THEN** the full manifest is inspectable before any install

### Requirement: Install is a version snapshot

A CLI install SHALL take the referenced pack's version snapshot at install time: no subscription is created, no update push occurs, and the CLI SHALL report the installed pack id and version for traceability.

#### Scenario: Reinstall takes the new snapshot

- **WHEN** a user re-runs install for the same pack after a new version was published
- **THEN** the installed files reflect the new version's snapshot

#### Scenario: No subscription side-effect

- **WHEN** an editor user installs a pack via the CLI
- **THEN** no subscription record is created at the facet service

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

### Requirement: Publish returns a self-hosted pack to the official market

The CLI SHALL provide a `publish` command that transports a pack manifest to the official facet market — from a local manifest file, or pulled from the pack's public detail on a self-hosted instance — authenticating through the device-pairing surface on the market's own domain. The CLI SHALL add no gate of its own: creator gating, manifest validation, tool-declaration gating, and author rate limiting all run on the market exactly as for a web publish, and the CLI SHALL surface their verdicts verbatim. Access tokens SHALL live only in process memory; the persisted pairing state SHALL be the device identity (id, keypair, paired account) and the source-to-official pack id mapping.

#### Scenario: Publish from a local manifest file

- **WHEN** `facet publish <path.json>` runs with a paired identity whose account is a creator
- **THEN** the manifest file is POSTed to the market's publish route and the new pack id and version are printed

#### Scenario: Cross-instance pull and push

- **WHEN** `facet publish <packRef> --from <self-hosted base>` runs and the pack is public on the source instance
- **THEN** the CLI pulls the stored manifest (including skill content) from the source instance's public detail and publishes it to the official market under the paired account's authorship

#### Scenario: Pairing on demand via bind code

- **WHEN** publish runs with no paired identity for the market domain (or the pairing was revoked)
- **THEN** the CLI prints and opens the market's bind-code page, reads a 6-digit code from stdin, pairs the device, and continues the publish

#### Scenario: Silent re-login on every run

- **WHEN** a paired device runs publish
- **THEN** the CLI silently logs in through the single-use challenge before publishing and stores no token on disk

#### Scenario: Validation errors pass through verbatim

- **WHEN** the market rejects the manifest
- **THEN** the CLI prints the market's validation errors item by item and stores nothing

#### Scenario: Creator gate refusal is surfaced with guidance

- **WHEN** the paired account is not in a creator group
- **THEN** the CLI reports the market's 403 with guidance that the paired account needs creator membership, and does not retry

#### Scenario: Source-to-official id mapping is remembered

- **WHEN** a first publish of a source pack succeeds and a later publish of the same source pack runs without `--pack-id`
- **THEN** the CLI reuses the remembered official id to append a new version; if that official pack no longer exists, the CLI reports the market's error instead of silently double-publishing
