# connector-credentials Delta — add-connector-console-link

## MODIFIED Requirements

### Requirement: Settings panel entry for the connector credential

设置面 SHALL 提供一个 connector 凭据卡片：可粘贴 PAT、显示已连接/未连接状态与更新时间、可断开，并在未连接时说明 PAT 从何处获取（connector 的「我的连接」页面）。卡片 SHALL 在已连接与未连接两态都提供「打开连接器控制台」入口（新标签打开 connector 的 `/me` 用户面板——未连接态是指引终点，已连接态是管理入口）；入口地址 SHALL 取自部署基线中 connector 服务行的 origin + `/me`（与粘贴探活同源，不另行硬编码），基线无该行时入口隐藏、指引降级为纯文案。

#### Scenario: 未连接时可粘贴

- **WHEN** 用户打开设置面且尚无 connector 凭据
- **THEN** 卡片显示未连接与获取 PAT 的指引，并提供粘贴入口

#### Scenario: 已连接时显示状态并可断开

- **WHEN** 用户已连接
- **THEN** 卡片显示已连接与更新时间，并提供断开操作

#### Scenario: 控制台入口两态常显

- **WHEN** 用户查看 connector 凭据卡片，无论已连接或未连接
- **THEN** 卡片提供「打开连接器控制台」入口，新标签打开 connector 的 `/me` 用户面板

#### Scenario: 入口地址来自部署基线

- **WHEN** 部署基线的 mcp.json 存在 connector 服务行
- **THEN** 入口地址为该行 url 的 origin 拼 `/me`，且凭据状态端点的投影携带该地址
- **WHEN** 基线无 connector 服务行
- **THEN** 入口隐藏，卡片指引降级为纯文案（不渲染死链或硬编码域名）
