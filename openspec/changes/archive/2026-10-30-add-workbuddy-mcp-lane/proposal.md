## Why

萬星与谦面的供给进不了腾讯 WorkBuddy：团队用户的工作台里没有我们的入口，只能靠人工抄一段 MCP 配置。
WorkBuddy 是 CodeBuddy Agent CLI 之上的桌面 Product，其开放面已支持远程 MCP（用户级
`~/.workbuddy/mcp.json`、项目级 `<项目>/.workbuddy/mcp.json`，`type: http` + `url` + `headers`），
而谦面 CLI 现有的五个 target（Claude Code / Cursor / ZCode / Codex / Gemini CLI）不含它——
一条命令能完成的事，今天要用户手写 JSON、手贴调用键。

同时本单把「我们的 OAuth 发现能力能不能让这个客户端免贴键」从推论变成了逐环实测，走了三跳：
第一跳判「不通，卡在授权服务器缺 `registration_endpoint`（RFC 7591 动态注册）」；第二跳翻案——
错在把 DCR 当必经环节：MCP 规范里 DCR 是 MAY（2026-07-28 版起弃用），静态 client_id 才是优先路径，
SDK provider 拿到 `oauth.clientId` 即短路注册；配套身份/网关侧三处（Logto Native 应用、网关 origin
注册为 API 资源 + 租户 custom-JWT、accepted_audiences 补丁 sha-c216f47），**服务端免键车道端到端
实证（initialize 200 + tools/list 160+）**。第三跳按出厂代码逐路径核定案客户端侧：5.9.3 只有
连接器/市场模板路径消费 `oauth.clientId`，用户级 mcp.json 加载器丢弃该块——所以 CLI `--oauth`
写的是同形**前瞻条目**（客户端接线即激活），**今日真连接=贴键**。本单把贴键车道做成可用产品、
把免键车道做到「服务端就绪 + 前瞻形状落盘」，三层证据链写进指南（避免下一个人再推、再误判）。

## What Changes

- **facet CLI 新增第六 target `workbuddy`**：技能安装按该客户端的目录约定落盘；`install --write-mcp`
  写它原生的 MCP 配置（用户级与项目级各一），条目形状为 `type: "http"` + `url` + `headers`。
- **两条连接车道**：贴键 = `facet connect` 铸键 + `install --write-mcp` 写 `headers.Authorization`；
  免键 = `install --oauth [--oauth-client <id>] --write-mcp` 写 `oauth.clientId` 静态客户端条目
  （零凭据落盘；服务端就绪、5.9.3 客户端用户文件消费待版本——前瞻形状）。指南写明免键机制、
  三跳定案过程与已知非阻塞项。
- **文档与单源测试同步**：新增 `docs/ecosystem/workbuddy.md` 指南、`docs/ecosystem/client-matrix.md`
  增列；`scripts/test-facet-docs-facts.mjs` 的「文档事实 == CLI 两张表」断言随新 target 自动咬合。
- **冒烟覆盖**：`scripts/smoke-facet-clients.mjs` 增加新 target 的写入形状断言（路径 + 条目键名）。
- **明确不做**：不碰插件市场分发（兄弟单 `add-pack-marketplace-git-channel`）、不做 Buddy 应用
  （需审核，属对接而非开放能力）、不改网关 MCP 契约与注册处行为。

## Capabilities

### New Capabilities

（无新增 capability：本单是既有安装面与既有连接能力的扩面，行为新增落在既有 requirement 的目标集合上。）

### Modified Capabilities

- `facet-editor-cli`: 「Skills install into editor targets」的目标集合由五个扩到六个并新增 workbuddy
  的技能落盘约定；「MCP references are honest about credentials」的目标表新增 workbuddy 的用户级/项目级
  配置文件与条目形状。

## Impact

- 代码：`facet/cli/facet.js`（`SKILLS_SUBDIR`、`MCP_TARGETS`、`writeMcpConfig`、帮助文本）。
- 测试：`scripts/test-facet-docs-facts.mjs`、`scripts/smoke-facet-clients.mjs`、CLI 单测。
- 文档：`docs/ecosystem/workbuddy.md`（新）、`docs/ecosystem/client-matrix.md`。
- 免键车道配套（1.3 翻案，身份/网关侧，均在生产落地）：Logto 生产配置（native 应用 + API 资源 +
  租户 custom-JWT）；网关 fork 线 `fd-keyless-mcp-audience`（基座=自报生产线 506f127d，补丁
  c216f479，镜像 sha-c216f47）+ GitOps d8d99246。详见 design D4 与 tasks 1.3/6.3。
- 依赖：无新增依赖；不涉及镜像层变化（纯 CLI + 文档 + 测试；网关补丁属身份/网关侧单线）。
- 风险面：WorkBuddy 的技能目录约定在文档中未完全统一（MCP 走 `~/.workbuddy/`，项目级技能文档写作
  `.codebuddy/skills/`），落盘路径必须由真机走查定案，不得照抄猜测。
