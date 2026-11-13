# Proposal: add-websearch-settings

## Why

web_search 是每个部署默认开箱可用的能力，但它的接线（relay 地址、relay 令牌）只存在于部署环境变量与 GitOps 清单里——用户在设置界面里看不到、改不了，甚至在「技能与工具」里点编辑 websearch 再保存会把 `envRefs` 静默丢掉（表单只建模 command/args/env/url/headers），使搜索能力悄悄退化。平台其他同类凭据（模型 API key、registry 连接、connector PAT）都有各自设置面板，搜索不该例外；且 relay 令牌已 per-cell 作用域化（add-mcp-credential-hygiene），"共享秘密不进 UI"的原顾虑不再成立。

## What Changes

- 新增 Settings 分区 **「网络搜索」（slug `websearch`，Capabilities 组）**：管理员可在此配置 relay 地址与令牌、一键测试连通性、清除回退到部署环境变量。
- 配置落 `deployment_config`（branding 同款 stored→env 解析），**令牌 write-only**（读取面只回 `hasToken: true/false` 与尾 4 位掩码，绝不回明文）。
- 解析优先级：存储值 → 进程 env（`SEARCH_RELAY_URL` / `SEARCH_RELAY_TOKEN`）→ 未配置。写入时若该 cell 已配 scoped master，令牌同样按 cell 派生（存储值只是 master 或静态兜底，不破坏作用域化）。
- **修复同域既有缺陷**：MCP 编辑表单保存时保留 `envRefs`（表单不认识该字段导致 websearch 接线被抹）。
- websearch 的 MCP 行在「技能与工具」中标注"由「网络搜索」配置"，编辑入口引导到新分区，避免用户在错误的地方改坏接线。

## Capabilities

### New Capabilities

（无新增 capability——本变更全部并入既有 capability 的需求面。）

### Modified Capabilities

- `web-search`: 新增"relay 接线可在设置界面配置"需求组——配置读写端点（管理门）、令牌不回显、连通性测试、清除回退、优先级（存储→env）、写入热生效（无需重启即重写 patch）。
- `settings-surface`: 分区清单新增 `websearch`（Capabilities 组，管理员可见），slug 稳定、deep link 可寻址。
- `extension-management-ui`: MCP 编辑表单保存保留 `envRefs`；bundled websearch 行渲染"配置在「网络搜索」"指引而非可编辑接线。

## Impact

- 后端：`server/routes/misc.js`（新 `/api/config/websearch` GET/PUT + `/api/config/websearch/test` POST）、`dsh-profile.js`（envRefs 解析点读 stored 覆盖）、`db.js`（复用 `deployment_config`，无迁移）。
- 前端：`web/src/components/settings/WebSearchSection.tsx`（新）、`sections.ts`（注册分区）、`McpServerForm.tsx`（envRefs 保留 + 指引）、`web/src/lib/websearch-api.ts`、五语 locale。
- 部署：无 GitOps 变更（env 兜底路径不变）；现网 websearch 行为在未配置存储值时逐字节不变。
- 不改 relay、不改 dsh 镜像、不改 registry。
