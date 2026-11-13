# Proposal: add-facet-infra-pages

## Why

谦面市场线 F1.2（`docs/facet-market-roadmap.md`，伞文档 2026-10-12）：诉求 5「平台提供的
skills 和 MCP 等基础设施有充分介绍」——`#/mcp` 今天只有卡片（名称/描述/端点/所需组），
每 server 的工具面、来源与许可证、示例调用无处可看；**skills 目录在谦面域完全没有门面**
（注册处 180 条技能只在壹座扩展市场可见）；「平台基建（MCP/skills）vs 包内容（pack）」
的叙事缺失，访客分不清货架上的东西哪些是平台给的、哪些是包自带的。

摸底发现（2026-10-12）：注册处条目**已带**所需数据——server 条目有 `license`/
`provider_organization`/`tool_list`（工具对象含 name+description）；skill 条目有
`repository_url`/`author`/`tags`/`metadata.extra`（生态素材的来源与许可证标注正是
ecosystem-curation spec 的既有承诺，但谦面域看不到）。缺口在**桥映射与 facet 路由把
这些字段裁掉了**，不在数据源。

## What Changes

- **MCP 深度页**：`#/mcp` 每 server 卡片可展开/进入深度视图——完整工具清单（名称+描述，
  来自注册处 `tool_list`）、来源与许可证（`license`/`provider_organization`/tags 如实
  标注，无则显示「未标注」而非编造）、所需组与档位如实标注、端点与接入方式；深度数据
  按需加载（卡片列表不进默认载荷）。
- **skills 目录门面**：`#/mcp`（或新 hash）承载注册处 skills 目录——名称/描述/来源
  （repository_url）/作者/tags，与 MCP 卡片同一货架纪律；匿名可见公开条目，组门控条目
  按身份过滤（复用 mcp-catalog 的 visibility 规则）。
- **「平台基建 vs 包内容」叙事段**：在 MCP/skills 视图顶部（或 intro 呼应）用一段文字
  讲清两者的关系与装法差异。
- **桥映射扩展**：`registry-bridge.js` 的 `mapServer`/`mapSkill` 保留
  license/provider/toolList/repositoryUrl/author 字段；facet 路由 `mcp-catalog.js`
  透出深度页所需载荷（工具清单仍惰性：列表路由不带 tool_list，深度路由才带）。

## Capabilities

### New Capabilities

（无——全部为既有能力的 requirement 修改）

### Modified Capabilities

- `facet-platform`: 「MCP catalog cards on the facet surface」扩为卡片+深度页两层
  （工具清单/来源许可证/档位标注、按需加载、只读纪律不变）；新增 skills 目录呈现
  （或并入同 requirement）；「Shell views are addressable hash routes」若新增 hash
  则同步更新路由清单。
- `ecosystem-curation`: 「Ecosystem entries carry provenance and license marks」的
  可见面从「catalog listings and pack detail views」扩到谦面域的 MCP/skills 深度页
  （既有承诺的兑现面补齐）。

## Impact

- **代码**：`registry-bridge.js`（mapServer/mapSkill 字段保留）、`facet/mcp-catalog.js`
  （深度路由+skills 路由+载荷裁剪）、`facet/web/src/McpCatalog.tsx`（卡片+深度视图，
  或新组件）、五语 locale（`web/src/locales/*/common.json`）。
- **API**：facet 域新增只读端点（如 `/api/mcp-catalog/:name` 深度、`/api/skills-catalog`）；
  注册处零改动（数据已在）。
- **e2e**：哨兵扩断言——深度页工具清单渲染、skills 目录渲染、组门控过滤、只读无写操作。
- **风险**：注册处 tool_list 可能未刷新（`refresh-registry-tool-list.mjs` 是既有补齐路径）；
  无 license 的老条目如实显示「未标注」。
