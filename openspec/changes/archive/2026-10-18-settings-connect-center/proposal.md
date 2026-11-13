# settings-connect-center

## Why

设置弹窗把「让能力可用」这件事撕成了三处五个范式：五张凭据连接卡（分属 JWT/PAT/设备配对/ID-token/sk- 粘贴四种认证模型）堆在「技能与工具 → 商店」tab 的货架上，搜索接线和模型 key 又各居「网络搜索」「模型」两个分节；「谦面·工具市场」与「谦面市场」两个几乎同名的区块相邻摆放，五个品牌名（萬星·词元/谦面/萬星·连接器/柏讯/识律）无任何名词表可查。这是后续词元账号一体化（L2a）与对话内连接引导（L3）的地基刀：先把「连接」立成一等概念，后续能力才有落点。

## What Changes

- 新设设置分节「**连接**」（slug `connections`，能力组首位），收拢现有全部凭据连接卡：谦面（归组单卡：工具市场登录 + 市场设备配对两行）、萬星·连接器、产品线操作（柏讯/识律）、柏讯·模拟交易；卡面各配一句职责副标题
- 「网络搜索」分节整体退役：用户 BYOK SerpAPI 密钥与 admin 共享搜索服务接线（relay 配置 + 池健康）迁入连接分节「搜索服务」卡；`/settings/websearch` 深链重定向至连接分节对应面板
- 「技能与工具 → 商店」tab 纯货架化：连接卡全部迁出，tab 从三个（已启用 | 商店 | 外部源）收敛为两个（已启用 | 商店）；商店内部分区「市场目录 | 外部市场（未经审校）」，外部市场仅在技能子视图出现（修复 type=mcp 下挂纯技能市场页的错位）；`?tab=external` 深链映射到商店内分区
- 连接分节顶部提供可折叠品牌速查（萬星·词元/谦面/萬星·连接器/柏讯/识律各一行一句话）
- 新增 `/api/connections` 状态聚合端点：一次返回当前用户全部连接的状态投影（无凭据本体），供 L1b 应用中心徽章与 L3 对话内引导复用
- 线铸造（line mint）回跳与 `credential-required` 安装门禁的指引路径改指连接分节
- i18n：补全 LineOps/FacetMarket 面板缺失的 locale 键，新增分节/分区文案三语（zh-CN/en/ja）对齐
- 清理死代码：无引用的 `MarketTab.tsx`/`InstalledTab.tsx`、`ExtensionsPage` 过时注释

非目标：万星 Caller 与词元账号的合并（L2a）、专家 tab 混类重整、应用中心网格统一（L1b）、外部市场新增数据源。

## Capabilities

### New Capabilities

- `connection-center`: 设置「连接」分节——七类用户级凭据连接与搜索服务接线的唯一管理面；品牌速查；`/api/connections` 状态聚合端点（只读投影，凭据本体永不出现在响应中）

### Modified Capabilities

- `settings-surface`: 分节清单变更——能力组首位新增 `connections`；`websearch` 分节退役为稳定重定向（slug 保持可寻址，满足既有 slug 稳定性要求的语义从「原地分节」变为「稳定重定向到连接分节」）；zh-CN 分节标签更新
- `extension-management-ui`: 「技能与工具」tab 结构从三个收敛为两个；连接面板（RegistryConnect/ConnectorConnect/FacetMarketConnect/LineOpsConnect/PaperTradingConnect 五卡）从商店 tab 迁至连接分节；外部源从独立 tab 变为商店内「外部市场」分区且仅技能子视图可见；`?tab=market` 深链保持解析（连接面板移除后指向纯货架）
- `external-skill-sources`: 外部技能的呈现位置从独立 tab 改为商店内分区；来源/许可/「未经平台审校」标记与知情安装（服务端强制确认）要求全部保持不变

## Impact

- **前端**：`web/src/components/settings/`（SettingsDialog、sections.ts、新 ConnectionsSection）、`web/src/components/extensions/`（McpMarketView 瘦身、ExternalSourceTab 改分区、五张连接卡迁址）、`web/src/locales/*/common.json`
- **后端**：`server/routes/misc.js`（新增 /api/connections 聚合，只读投影各凭据模块现有状态 API）、`server/routes/line-credentials.js`（回跳地址）、`server/routes/extensions.js`（credential-required 错误负载的指引路径字段）
- **不动**：各凭据模块的存储/铸造/注入/401 处理逻辑（registry/connector/facet-market/line/paper-trading-credentials 全套保持）；search-relay 本体与 `retire-search-relay-direct` 在途 change 的边界
- **兼容**：全部既有深链（/settings/websearch、/settings/mcp?tab=market、?tab=external、/settings/skills 别名）保持可解析；凭据数据零迁移（L1 仅挪 UI，不动物理存储）
- **词汇表**：CONTEXT.md 已新增「连接」「外部技能」词条，本 change 落实其用户面
