## Why

腾讯 WorkBuddy（CodeBuddy Agent CLI 之上的桌面 Product）的市场只接受**按地址添加**，且其官方文档写明：
URL 型市场是 catalog 分发方式，只取 `marketplace.json` 与相对路径条目的 `plugin.json`，
「无法通过 HTTP 目录列表递归镜像任意插件文件」——因此**含技能/命令/Hooks 的插件在 URL 型市场里装不上**，
整个市场必须改用 Git/ZIP 发布。

这意味着谦面今天给 Claude Code 出的那个 JSON 端点（`facet/marketplace-json.js`）在 WorkBuddy 侧
**不可用**：用户能把市场加进去，点安装却拿不到技能正文。要让谦面的供给真正进入这个客户端，
需要一个**仓库形态的市场**——一份带完整插件目录树的 Git 快照。

## What Changes

- 谦面新增**市场仓导出**能力：把「公开 ∧ 非 unlisted ∧ 已策展」的包投影成一个 CodeBuddy 兼容的
  市场快照（根 `.codebuddy-plugin/marketplace.json` + `plugins/<packId>/` 插件目录树），可重复生成并推到
  一个 Git 仓；用户在 WorkBuddy「插件 → + → 输入市场地址」添加该仓即可安装。
- **收录口径复用既有单一来源**：与 Claude 端点同一套 `loadListed`（策展 `category ∨ featured`，
  算子白名单 `FACET_MARKETPLACE_PACK_IDS` 覆写），不新造第二套过滤。
- **插件内容**：包的技能（含辅助文件）按文件落盘为插件技能目录；agents/persona 投影为插件智能体；
  MCP 引用**只做连接指引**、不进插件本体（与 Claude 端点同一姿态）。
- **生成即校验**：快照生成后先自检（清单可解析、每个条目目录齐、路径无逃逸），通过才原子替换并提交；
  失败保留上一份可用快照。
- **明确不做**：不改客户端 MCP 连接方式（兄弟单 `add-workbuddy-mcp-lane`）、不做插件官方市场提交
  （他们无自助提交口）、不改包发布门与策展规则。

## Capabilities

### New Capabilities

（无新增 capability：这是既有市场分发面的一种新出口形态，行为落在 pack-marketplace 上。）

### Modified Capabilities

- `pack-marketplace`: 新增「CodeBuddy 兼容市场仓」要求——快照的收录口径、插件内容边界、MCP 只做指引、
  刷新时效与失败保留 last-good；与既有「Claude marketplace manifest endpoint」并列而非替代。

## Impact

- 代码：新增市场仓投影模块（复用 `facet/marketplace-json.js` 的 `loadListed` 与 `lib/skill-files.js`
  的路径安全规则）；一个生成/校验/推送脚本。
- 数据：无新增表；只读取既有 packs 注册表与版本快照。
- 凭据：Git 推送凭据沿用既有发布通道的做法（不入库、走环境注入）；**仓库内容严禁包含任何调用键**
  （插件本体无凭据，MCP 只有指引）。
- 运维：新增一个「刷新市场仓」的例行动作；失败不破坏上一份可用快照。
- 文档：`docs/ecosystem/workbuddy.md` 增「用市场仓安装」一节（兄弟单已在建该文件）。
