## Why

素材广场需要一个对外的"理解面"：让不同语言背景的**人**和 **AI** 都能理解我们提供了哪些基础设施、如何提供、现在具备哪些素材（用户原始令，2026-11-02）。平台内部已把 MCP 工具注释成"对 localized 人 + 对 AI canonical"的双面（market-annotations 生产层），广场把这个立场公开发布；清单真源复用 facet 市场单一上市判据，官网按 house 配方纯静态上产（site-zhiyu + 雷池/Caddy 先例）。

**v2 追加（用户裁定，2026-11-03）**：广场的核心是**素材清单本身**，而 v1 只暴露了 1/3——skills 与 MCP 两类为 0，尽管它们有现成的匿名可读端点（`/api/skills-catalog` 197 条、`/api/mcp-catalog` 13 条公开服务 + 深度路由全 tool 面 649 工具）。三类素材全量接入 + 三域一门（agent/skills/mcp 三域都通向此站）。

## What Changes

- 新增 `site-plaza/` 纯静态官网（agent.finddatatech.cloud，**2026-11-03 已上产**）：五语人面（hero + 五类素材卡墙 + 机制链四段 + 素材目录 + 给谁用 + 五行梯页脚）+ AI 面（/llms.txt、/llms-full.txt、/catalog.json、/materials/*.md、/infrastructure.md、人面 JSON-LD + 机器孪生链接；根路径 /llms.txt + /robots.txt 已补）。
- **v2 hero 重定心**：hero 主数据从单一功能集计数改为**三类素材活计数**（智能体 75 · 技能 · MCP 服务 · 工具数 + 快照截至）——素材清单本身是站点核心。
- **v2 三类素材接入**：导出管线从三源摄取——packs（现行）/ skills-catalog（zh 直通 + provenance 如实标注，翻译批后续）/ mcp-catalog（每服务页内嵌全 tool 面与 license/provider，不拆工具页）；pack 素材页枚举其 manifest 自带的 skills 与 MCP 引用（"壹座 packs 里面有的"字面暴露）。catalog v2：category 枚举值不变，skill 与 mcp 两类从 0 变真数据；slug 按 species 加前缀（pack-/skill-/mcp-）防跨注册表碰撞。
- **v2 三域一门**：agent. = 正门（不过滤）；skills. = 同站别名（hostname 感知预选技能类）；mcp. = **仅匿名根路径** 302 跳广场（MCP 类预选），`/<server>/mcp` 协议端点、控制台、/api/* 零触碰，带注册表会话者照旧进控制台（registry-product-home spec 场景保持）。三域一张边缘证书全覆盖（SAN 重签不得挤掉任何旧域——zhengxin 挤出事故律）。
- 导出校验门：ai_readable 六条 lint、**逐源数目对账**（packs 对 marketplace.json 权威；skills/mcp 各对其源端点计数）、llms.txt 链接可达断言、五语 parity 沿用 check-locales + 站点侧 parity 门。
- HTML 素材目录画廊双层新鲜度：客户端实时拉 /api/packs，失败静默退回构建期快照并标注"快照截至"；画廊加 species 标签页。
- 品牌串全部按 v5 终词「壹座·智能体素材广场」/ "Yizuo Agent Materials Plaza"（前置：rename-agent-materials-plaza，已 apply 6/7）。

## Capabilities

### New Capabilities

- `agent-materials-plaza`: 广场官网的行为契约——五语人面结构（hero=素材清单、species 标签页、hostname 感知）、三源摄取与逐源对账、AI 机器面形状、快照新鲜度语义、导出校验门、自足 Markdown 纪律、稳定 slug、三域一门。

### Modified Capabilities

（无——facet 市场/技能/MCP 三端点行为零改；本 change 只读三源，不改三源。mcp. 根跳转在 Caddy 边缘层落地，registry 应用与 registry-product-home spec 的行为场景保持不变。）

## Impact

- 新文件：`site-plaza/`（静态站，纯 HTML/CSS/JS + 五语 JSON 文案）、`scripts/plaza-export.mjs`、`scripts/test-plaza-export.mjs`、`scripts/test-plaza-site.mjs`、`scripts/deploy-plaza.sh`。
- 部署：`agent.finddatatech.cloud` 已上产（雷池 site 31 并域 cert 59，17 域回归全绿，台账 §9）；v2 追加 skills. 域（DNS 已解析、Caddy 块新加、雷池 site 31 并域 17→18、**证书重签 18-SAN**——`-d` 清单逐个核对）与 mcp. 根跳转（Caddy mcp 块内加匿名根 matcher）。
- 依赖：只读 facet 三端点（匿名可读面）；不新增任何写路径、不新增服务进程——纯静态 + 构建期脚本。
- 门：`test-plaza-export.mjs` + `test-plaza-site.mjs` 入 unit 冒烟；ai_readable lint 门入导出（红则构建失败）。
- 前置：`rename-agent-materials-plaza`（品牌终词）先行归档或同班落地。
- 外部记挂：www 官网 products/facet 页互链；yongyi 反链；skills 的五语翻译批（zh 直通为先，provenance 如实）；兄弟站（zhiyu/yongyi/facet）页脚互链（zhiyu 往返已上线）。
