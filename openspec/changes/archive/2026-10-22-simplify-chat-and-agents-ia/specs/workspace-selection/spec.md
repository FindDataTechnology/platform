## ADDED Requirements

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
