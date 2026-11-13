# add-external-skill-sources — Design

## Context

技能货架现状（本仓，亲手核验）：技能入库三条路（bundled JSON / registry 单装 / pack 内联），统一落 `custom_skills` 表并经 `skill-materialize.js` 物化为单文件 SKILL.md；远端条目只有一条链路 `registry-bridge.js`（自家 mcp-gateway-registry fork，形状钉死，TTL 300s，坏响应保留旧快照）。生态准入由 `ecosystem-curation` spec 治理（人工审校、无公开提交面）。

外部市场事实（本轮一手实测）：SKILL.md 是跨厂商事实标准（agentskills.io 6 字段规范，46 客户端）；腾讯 SkillHub 与 Smithery 均有免鉴权 REST 索引。实测形状：
- SkillHub：`GET /api/v1/search?q=&limit=`（**无 total 无游标，pageSize 被忽略**）、`/api/v1/categories`（13 个中文分类）、`/api/v1/download?slug=`（302 → COS zip）。条目字段 `slug/name/displayName/summary/version/category/tags/downloads/stars/…`。search 响应只有 `results` 数组。
- Smithery：`GET /api.smithery.ai/skills?pageSize=&page=`（规范分页，`totalCount` 25k+），条目 `slug/namespace/displayName/description/gitUrl/externalStars/categories/…`；**内容可达性经 gitUrl → GitHub raw 实测成立**（`frontend-design` 拉到真实 SKILL.md）。

DeepSeek 线定案：官方无市场（索引格式 proposal 未实现），本 change 不涉及 dsh 插件。

## Goals / Non-Goals

**Goals:**
- 源适配器契约 + 源注册表，把「多源镜像」做成模式而非一次性代码
- 刀一只读货架：聚合搜索、按源分组、来源三态、未经审校标记
- 与 registry-bridge 一致的运营姿态：快照化、坏响应不清空、TTL 有界

**Non-Goals:**
- 安装/导入/任何内容落盘（刀二）
- `custom_skills` schema 变更、frontmatter 保留、名字归一化（刀二）
- facet 门面收录外部源（后置）
- 全量翻页与镜像完整性（只读货架做「发现」不做「穷举」）

## Decisions

**D1 — 适配器接口最小化：`list` + `get`，不做全量镜像。**
```js
// external-sources.js 内的适配器契约（不引新依赖，node fetch）
// list(query, { limit })  -> { entries: [...], error?: Error }   搜索/热门
// get(slug)               -> { entry, error? }                    详情
// 两者都返回归一化 Entry：{ source, id, name, displayName, description,
//   originUrl, licenseState: "declared"|"not-declared"|"unknown",
//   licenseText?, version?, versionLayer?, downloads?, stars?, tags[] }
```
备选「全量镜像本地 SQLite」（像 awesome-dsh-plugin 的 catalog.json）：刀一拒绝——25k 条镜像引入同步/存储/条款三摊成本，而聚合搜索已满足「发现」需求。刀二若装按钮要离线元数据再议。

**D2 — 缓存按「请求形状」键，快照模块独立于 registry-bridge。**
聚合搜索缓存键 = `(sourceId, query, limit)`；分类浏览缓存键 = `(sourceId, "cat", category)`。内存 Map + 时间戳即可（单进程，量级小）；不落盘——刀一只读，冷启动重拉可接受。坏响应路径与 registry-bridge 同款：保留 `{ at, data }` 旧快照，附 `stale: true`。不合并进 registry-bridge：那模块与自家 fork 的字段映射纠缠（`mapSkill`/`mapServer`），硬塞会把两个生命周期耦死。

**D3 — 聚合策略：`Promise.allSettled` 扇出，每源 top-N（默认 20），按源分组原样返回。**
不跨源排序、不合并去重（不同市场的同名技能是不同条目，来源徽章要求它们各自可见）。N 用 env `EXTERNAL_SOURCE_PAGE_SIZE` 可调。空源组照返（带 stale/error 态），不让单源失败炸整个响应。

**D4 — 来源三态映射，逐源定案：**
- SkillHub：条目无 license 字段（实测 search 响应）→ **unknown**；`description` 里的许可证自述不采信（无法机器判定）。originUrl = `https://skillhub.cn/skills/<slug>`。
- Smithery：条目无 license 字段 → **unknown**；originUrl = gitUrl（实测指向 GitHub 目录，本身就是上游源）。刀二接安装时再从 gitUrl 拉 LICENSE 升格为 declared/not-declared。
- 版本号记录 `versionLayer`（市场元数据 vs 包 frontmatter）——腾讯实测同包两层版本互相矛盾（_meta 1.0.13 vs frontmatter 2.1.0），现在就把「版本取自哪层」做进 Entry 形状，刀二直接受益。

**D5 — 路由与前端落点。** 服务端：`server/routes/extensions.js` 挂 `GET /api/extensions/external/sources`（启用源清单+健康态）、`GET /api/extensions/external/search?q=`、`GET /api/extensions/external/entry/:source/:slug`。鉴权：跟随现有 extensions 路由的门（登录用户）。前端：`ExtensionsPage.tsx` 加第三个 tab「外部源」，新组件 `ExternalSourceTab.tsx`；卡片带源徽章 + 「未经本平台审校」固定标 + 许可证三态 chip；detail 走现有 drawer 形态。`packages/core` extensions-api 加三个只读方法。

**D6 — env 语义。** `EXTERNAL_SKILL_SOURCES`：unset/空 = 全开（spec 场景钉死）；`skillhub` 单值 = 只开一个；含未知 id 忽略不报错。`EXTERNAL_SOURCE_PAGE_SIZE`：默认 20，上限 50（防刷）。

**D7 — 出站请求纪律。** 所有外部请求：显式 `AbortSignal.timeout(10_000)`、无凭据头、UA 标平台名。外站 URL 渲染一律 `rel="noopener noreferrer"`。外部元数据（displayName/description）只走文本渲染通道，不进 HTML 注入面。

## Risks / Trade-offs

- **CN 节点对 smithery 可达性未验证**（本机通≠prod 通）：上线核验任务包含从 prod 节点 curl；不通则 `EXTERNAL_SKILL_SOURCES=skillhub` 关停该源。风险上限 = 一个 tab 里少一个源。
- **Smithery 再分发条款未核**：刀一只读展示元数据 + 来源归属徽章，惯常合规；真镜像（刀二+）前必须核。记入任务。
- **外部内容只是「看见」不进运行时**：本 change 的注入面为零（无落盘），这是设计而非遗漏——刀二引入落盘时才需要注入面分析。
- **SkillHub 无分页**：聚合搜索每源 top-N 的 N 在 SkillHub 侧就是 `limit` 参数本身（实测被尊重）；翻页深度天然受限，与 D1 的「不做穷举」一致。
- **免费接口无 SLA**：快照 + stale 态已把失效降级为「显示旧数据」，不是页面白屏。
