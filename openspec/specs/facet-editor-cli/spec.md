# facet-editor-cli Specification

## Purpose
多编辑器安装面：让没有壹座账号的编辑器用户（Claude Code、Cursor 等）以最低摩擦获取功能集内容——CLI 装技能、下载面取原文，MCP 引用如实标注凭据要求（v1 不写 MCP 配置）。

## Requirements

### Requirement: Skills install into editor targets

The `@finddatatechonology/facet` CLI SHALL install a published pack's skills from the facet service into supported editor targets, v1 concretely Claude Code and Cursor, each target using its native skill layout (user-level by default, project-level where the target supports it). Installing SHALL write each skill's content with its name and description metadata, taken from the referenced pack version's snapshot.

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

The CLI and the download face SHALL present a pack's MCP references with their real connection endpoint and an explicit notice that connecting requires a per-user registry credential. v1 SHALL NOT write MCP connection configuration into any editor target.

#### Scenario: MCP reference prints endpoint and notice

- **WHEN** an installed pack declares MCP references
- **THEN** the CLI output lists each server's connection endpoint with a notice that connecting requires a registry credential
- **AND** no editor MCP configuration file is created or modified

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
