# Tasks: add-resource-filters

## 1. 服务端列表扩展

- [x] 1.1 `db.js`：扩展名→组映射单点定义（紧邻 `listResources`）+ `listResources` 接受 `groups`（CSV）与 `since`/`until`（ISO 字符串），SQL 以 `file_mime` CASE 出组列过滤、未命中归「其他」、`created_at` 区间比较；用 sqlite 冒烟脚本验证 groups×since×q×type 的组合过滤与「其他」兜底
- [x] 1.2 `db.js`：facet 计数查询（同 WHERE 的 `GROUP BY` 组列），`listResources` 响应加 `facets`，口径=时间窗+标题搜索、不含组选择；冒烟验证计数与逐组手数一致
- [x] 1.3 `server/routes/resources.js`：GET /api/resources 解析 `groups`/`since`/`until`，非法值 400 带原因码；curl 验证合法/非法参数两态

## 2. API 客户端类型

- [x] 2.1 `packages/core/src/api/resources-api.ts`：`ResourceListQuery` 加 `groups`/`since`/`until`，`ResourceList` 加 `facets` 字段类型；`packages/core` 构建通过

## 3. web 前端

- [x] 3.1 `web/src/hooks/useResourcesStore.ts`：筛选状态（timePreset、selectedGroups）、默认视图常量（全部 tab + 图表/文档/表格/图片）与进页重置、tab×组自洽的参数组装（全部不发 type；图表 tab 不发 groups；文件 tab 只发文件组）、筛选变化翻页归零、facets 状态随加载刷新；store 单测或组件冒烟通过
- [x] 3.2 `web/src/pages/ResourcesPage.tsx`：时间预设行（全部/今天/近7天/近30天，自然日语义客户端算 ISO 时间戳）+ 类型组 chips 行（tab 显隐：图表 tab 无组行；文件 tab 无图表 chip；计数、0 置灰不隐藏、多选即时生效）+ 无匹配空态（不清筛选）；`web/src/locales` 补 zh-CN/en 文案；页面手测四 tab×组×时间组合
- [x] 3.3 `ResourcesPage.tsx` 卡片补 createdAt 显示：`MM-DD HH:mm`（非当年补年份）、hover 全时间，图表卡与文件卡一致；眼见验证
- [x] 3.4 窄屏验证：chips 换行、时间预设横滚不溢出

## 4. 验证收尾

- [x] 4.1 `openspec validate add-resource-filters --strict` 通过；相关单测/e2e 全绿
