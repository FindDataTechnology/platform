## Why

谦面的分发面已经能覆盖六家客户端（CLI 写技能目录 + 代写 MCP 配置）、一个 Claude 原生 `marketplace.json` 端点、一个 WorkBuddy/CodeBuddy 兼容市场仓，但它缺的是**公开发现入口**：匿名用户和第三方索引器没有一条「在主流市场里搜得到谦面」的免费路径。同时，我们已有的公开仓（`FindDataTechnology/facet-marketplace`、`fd-mcp-registry`）本身就已经是主流技能市场（skills.sh / SkillHub）可爬的标准形状——内容就绪，只是没接上，而 MCP 官方 Registry 这条免费上架通道则连投影器都还没有。

这一批的落点是**复用同一个分发闸、再挂两个免费公开投影头**：MCP 官方 Registry（唯一的真代码缺口）+ 技能市场可索引化（几乎零代码，靠公开仓登记）。它把「发现」做成漏斗顶：零摩擦发现 → 想 7×24 跑就引导去萬星变现。**不做**收费/封闭通道（Smithery 增值托管、ChatGPT connectors 审核制），因为本变更的核心是用免费与公开资源。

## What Changes

- 新增 **MCP Registry 投影器**：把公开（`groups=[]`）的 MCP server 投影成官方 `server.json`（schema `2025-12-11`），反向 DNS 命名 `io.github.FindDataTechnology/*`，`remotes[]` 指向免键端点。
- 新增 **CI 发布脚本**：`mcp-publisher` 走 GitHub OIDC/OAuth 认领 namespace，免手填凭据上架。
- 复用**同一可见性闸**：投影器与现有 `loadListedPacks` / `loadMcpServers` 共用规则，禁止第二份拷贝（沿用 `marketplace-repo.js` 的单一规则纪律）。
- 免密钥纪律**贯穿投影层**：投影产出绝不嵌真凭据，命中凭据形状即拒绝（沿用 `CREDENTIAL_RE` 的思路），远端只放 URL。
- **技能市场可索引化**：确认并固化公开仓为 skills.sh / SkillHub 可爬的标准 `SKILL.md` + `.codebuddy-plugin/marketplace.json` 形状，登记市场地址（运营动作，近零代码）。
- **漏斗钩子**：registry / 市场 listing 的条目说明带「想 7×24 常驻 → 萬星」引导文案。
- 域名验证命名（`cloud.finddatatech/*`）作为**后续品牌升级路径**记录在 design，不在本变更实现。

## Capabilities

### New Capabilities

（无新增 capability；投影面增量落在既有两个能力上。）

### Modified Capabilities
- `ecosystem-access`: 新增「公开 MCP server 可投影为官方 Registry `server.json` 并上架」「公开技能/插件仓可被第三方技能市场索引」两条能力面。
- `pack-marketplace`: 新增「市场投影共用单一可见性与免密钥纪律」要求，约束所有市场形状投影器（含新 MCP Registry 投影）不得各写一份规则、不得输出凭据。

## Impact

- 代码：新增 `facet/mcp-registry-json.js`（投影器）与 `scripts/publish-mcp-registry.mjs`（CI 发布）；`facet/index.js` 挂载新投影路由；沿用 `facet/marketplace-json.js` 的 `loadListedPacks` 与 `registry-bridge.js` 的 server/skill 形状。
- CI：新增一条 MCP Registry 发布 workflow（GitHub OIDC，免费）。
- 运营/文档：`docs/ecosystem/` 增两篇（MCP Registry 上架、技能市场登记），更新 `client-matrix.md` 与 `facet-market-roadmap.md` 的 F2/F4 口径。
- 外部依赖：MCP 官方 Registry（`registry.modelcontextprotocol.io`，免费）、skills.sh、SkillHub——均为免费公开渠道，无付费依赖。
- 无 **BREAKING**：现有六客户端分发、Claude 端点、WorkBuddy 市场仓全部保持不变。
