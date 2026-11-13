# Tasks: add-facet-infra-pages

## 1. 数据面：桥映射与 facet 路由

- [x] 1.1 `registry-bridge.js` 的 `mapServer` 保留 `license`/`providerOrganization`/`numTools`（toolList 已在），`mapSkill` 保留 `repositoryUrl`/`author`/`tags`；单测断言字段透传
- [x] 1.2 facet 新只读路由 `/api/mcp-catalog/:name`（深度：toolList+provenance；组门控无权 404）与 `/api/skills-catalog`（列表+可见性过滤+分页）；单测覆盖匿名/组内/无权三态
- [x] 1.3 卡片列表端点形状不变（6 字段），确认深度载荷不进列表——单测钉住

## 2. MCP 深度视图

- [x] 2.1 `McpCatalog.tsx` 卡片可点开深度视图（`#/mcp` 内切换，不新增 hash）：工具清单（名称+描述）、license/provider/tags 标注、所需组与档位、端点与接入要点；无快照/无 license 如实标注
- [x] 2.2 深度数据按需加载（打开才 fetch 深度端点）；返回卡片列表态
- [x] 2.3 新 UI 文案五语齐，`check-locales.js` 通过

## 3. skills 目录门面

- [x] 3.1 `#/mcp` 增 skills 目录（tab 或分段）：名称/描述/来源 repository_url/作者/tags，生态 vs 官方可辨；分页+当前页搜索（照 packs 目录先例）
- [x] 3.2 可见性跟身份（匿名见公开，组内见门控）；只读无写操作

## 4. 叙事段与 e2e

- [x] 4.1 「平台基建 vs 包内容」叙事段落 `#/mcp` 顶部（讲清 MCP/skills 是平台给的基础设施、pack 是内容捆绑、装法差异）
- [x] 4.2 谦面壳哨兵 e2e 扩：深度视图工具清单渲染、skills 目录渲染、组门控过滤、只读无写；`#/mcp` reload 回目录态
- [x] 4.3 CI 全绿 + 生产实证（按 paas-release 标准线：in-pod 探针+浏览器验收）后归档
