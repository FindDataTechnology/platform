# workspace-selection Specification

## Purpose
The dsh runtime's working directory as a user-selectable setting: the boot workspace resolves from the `AGENT_WORKSPACE` deploy pin and then the persisted current choice; the server exposes the active path plus an LRU recents list over `list_workspaces`, validates a requested path (absolute, existing, readable and writable) before touching the runtime, and applies it by restarting the dsh child with the new `cwd` and broadcasting `workspace_changed`; the client asks for confirmation before switching mid-conversation.

## Requirements

### Requirement: The boot workspace resolves from a deploy pin, then the persisted current workspace

At boot the server SHALL resolve the dsh runtime's initial working directory in this order: the `AGENT_WORKSPACE` environment value when it validates (absolute, existing directory, readable and writable by the server process, symlinks resolved), else the persisted current-workspace preference when it validates, else the process working directory. An `AGENT_WORKSPACE` that fails validation SHALL fall back down the chain with a logged warning naming the rejected value and the fallback — never a silent return to an unwritable root. The env pin SHALL take precedence over the preference so a drifted or stale preference cannot strand the deployment.

#### Scenario: env pin wins

- **WHEN** the server boots with a valid `AGENT_WORKSPACE=/data/workspace` and a persisted preference pointing elsewhere
- **THEN** the runtime starts with `/data/workspace` as its working directory

#### Scenario: persisted current is restored when no pin is set

- **WHEN** the server boots without `AGENT_WORKSPACE` after the user switched to `/home/me/proj` in the previous run
- **THEN** the runtime starts with `/home/me/proj`

#### Scenario: invalid pin falls back loudly

- **WHEN** the server boots with `AGENT_WORKSPACE` pointing at a nonexistent or read-only directory
- **THEN** the runtime starts from the next valid tier in the chain
- **AND** the server logs a warning naming the rejected value and the workspace actually used

### Requirement: Server exposes the active workspace and recent workspaces

The server SHALL respond to a `list_workspaces` WebSocket message with the dsh runtime's current working directory and a list of previously used directories. The recents list SHALL persist across server restarts and SHALL be capped at a fixed maximum, evicting least-recently-used entries. The current workspace SHALL likewise persist across server restarts (subject to the boot-resolution precedence above), so a switch survives a restart unless the deployment pins `AGENT_WORKSPACE`.

#### Scenario: client requests workspaces

- **WHEN** a WebSocket client sends `{ "type": "list_workspaces" }`
- **THEN** the server SHALL reply with `{ "type": "workspaces", "current": "<abs path>", "recents": ["<abs path>", …] }`
- **AND** `current` SHALL be the absolute path the dsh runtime was initialized with

#### Scenario: recents survive a server restart

- **WHEN** the server is restarted after the user has switched workspaces
- **AND** a client sends `{ "type": "list_workspaces" }`
- **THEN** the previously used directories SHALL still be present in `recents`

#### Scenario: current workspace survives a server restart

- **WHEN** the server is restarted after the user switched to `/home/me/proj` and no `AGENT_WORKSPACE` is set
- **THEN** `current` SHALL be `/home/me/proj`

### Requirement: Server validates a requested workspace before switching

The server SHALL validate a requested workspace path before touching the dsh runtime. Validation SHALL require that the path is absolute, that it resolves (following symlinks) to an existing directory, and that the directory is readable AND writable by the server process — a read-only workspace recreates the unwritable-root failure this regime exists to prevent. A path failing any check SHALL be rejected with an `error` and SHALL NOT restart the runtime.

#### Scenario: relative path is rejected

- **WHEN** a client sends `{ "type": "set_workspace", "path": "./src" }`
- **THEN** the server SHALL reply with an `error` naming the reason
- **AND** SHALL NOT restart the dsh runtime

#### Scenario: nonexistent path is rejected

- **WHEN** a client sends a `set_workspace` for a path that does not exist
- **THEN** the server SHALL reply with an `error`
- **AND** the runtime SHALL continue serving prompts from the previous workspace

#### Scenario: path to a file is rejected

- **WHEN** a client sends a `set_workspace` whose path resolves to a regular file
- **THEN** the server SHALL reply with an `error`
- **AND** SHALL NOT restart the dsh runtime

#### Scenario: read-only directory is rejected

- **WHEN** a client sends a `set_workspace` whose path resolves to a directory the server process cannot write to
- **THEN** the server SHALL reply with an `error` naming writability as the reason
- **AND** SHALL NOT restart the dsh runtime

#### Scenario: symlink is resolved before validation

- **WHEN** a client sends a `set_workspace` for a symlink pointing at a directory
- **THEN** the server SHALL validate and store the resolved target path
- **AND** the `workspace_changed` broadcast SHALL carry the resolved path

### Requirement: Server switches the workspace by restarting the dsh runtime

The server SHALL apply a validated workspace change by restarting the dsh child with the new `cwd`, because `cwd` is fixed in the `initialize` handshake and no RPC changes it. On success the server SHALL broadcast `workspace_changed` to all clients, SHALL add the path to the recents list, and SHALL persist the path as the current workspace so the next boot restores it (unless the deployment pins `AGENT_WORKSPACE`). A failed switch that restores the previous workspace SHALL persist the restored path as current.

#### Scenario: valid workspace switch restarts the runtime

- **WHEN** a client sends `{ "type": "set_workspace", "path": "/Users/me/proj" }` and the path validates
- **THEN** the server SHALL restart the dsh runtime with the new `cwd`
- **AND** SHALL broadcast `{ "type": "workspace_changed", "path": "/Users/me/proj" }` to all connected clients
- **AND** the path SHALL appear at the head of the recents list
- **AND** the path SHALL be persisted as the current workspace

#### Scenario: switch is rejected while streaming

- **WHEN** a client sends `set_workspace` while the agent is streaming a response
- **THEN** the server SHALL reply with an `error` stating the agent is busy
- **AND** SHALL NOT restart the runtime

#### Scenario: failed restart is reported

- **WHEN** the dsh runtime fails to start with the new workspace
- **THEN** the server SHALL broadcast an `error` describing the failure
- **AND** SHALL attempt to restore the previous workspace
- **AND** the restored workspace SHALL be persisted as current

### Requirement: Client warns before switching workspace mid-conversation

The client SHALL require explicit confirmation before emitting `set_workspace` when the current session contains messages, because switching the workspace leaves the loaded conversation referencing paths that no longer resolve.

#### Scenario: non-empty session prompts for confirmation

- **WHEN** the user selects a different workspace and the current session has at least one message
- **THEN** the client SHALL present a confirmation naming the consequence
- **AND** SHALL emit `set_workspace` only when the user confirms

#### Scenario: empty session switches without confirmation

- **WHEN** the user selects a different workspace and the current session has no messages
- **THEN** the client SHALL emit `set_workspace` immediately

### Requirement: 工作目录控件以项目语义呈现

客户端 SHALL 将 dsh 工作目录以「项目」语义呈现，与侧边栏的项目词汇
（openspec: sidebar-workspaces）对齐，不再向用户裸露文件系统概念：

- ⋯ 溢出菜单中的工作目录区 SHALL 更名为「会话项目」，默认显示**项目名**
  （当前 workspace 路径的既有项目名解析，无法解析时显示路径末段），
  MUST NOT 默认展示完整绝对路径；
- 绝对路径输入与（桌面壳内的）文件夹浏览 SHALL 收进同一区块的「高级」
  展开，未展开时不占位；
- 切换工作目录的既有服务端契约（校验、重启、确认、recents）全部不变，
  本需求只改呈现；
- 输入框左下的权限 chip 文案 SHALL 改为口语三档：「仅对话」/
  「可读写项目文件」/「完全访问」（对应 read-only / workspace-write /
  danger-full-access 的既有权限预设，语义与风险闸不变）。

#### Scenario: 默认只见项目名

- **WHEN** 用户在 ⋯ 菜单打开工作目录区且当前 workspace 为
  `/data/cells/1da519d4c1c0bf89/runtime`
- **THEN** 区块标题为「会话项目」，显示解析出的项目名（或路径末段
  `runtime`），完整绝对路径不在未展开区域出现

#### Scenario: 路径输入收进高级展开

- **WHEN** 工作目录区渲染完成
- **THEN** 「输入文件夹绝对路径」输入框与浏览按钮位于「高级」展开之后，
  默认收起；展开后行为与既有契约一致（绝对路径校验、中途切换确认）

#### Scenario: 权限 chip 文案口语化

- **WHEN** 权限 chip 以 `workspace-write` 预设渲染
- **THEN** chip 显示「可读写项目文件」；`read-only` 显示「仅对话」；
  `danger-full-access` 显示「完全访问」且保留既有风险确认闸
