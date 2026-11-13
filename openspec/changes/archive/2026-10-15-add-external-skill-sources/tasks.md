# add-external-skill-sources — Tasks

## 1. 源适配器层（服务端）

- [x] 1.1 新建 `external-sources.js`：适配器契约（`list(query, {limit})` / `get(slug)`）、归一化 Entry 形状（含 `source`/`originUrl`/`licenseState`/`versionLayer`）、源注册表、`EXTERNAL_SKILL_SOURCES` 解析（unset/空=全开、未知 id 忽略）
- [x] 1.2 共享出站 fetch helper：`AbortSignal.timeout(10s)`、无凭据、平台 UA；快照缓存 Map（键=请求形状，TTL ≤1h，坏响应保留旧快照 + `stale: true` + `snapshotAt`）
- [x] 1.3 SkillHub 适配器：`/api/v1/search`（q/limit，无游标按实情处理）、`/api/v1/categories`、详情 `get(slug)`；licenseState=unknown、originUrl=`skillhub.cn/skills/<slug>`；单测：归一化字段、无 license 字段的 unknown 落位、空 results
- [x] 1.4 Smithery 适配器：`/skills?pageSize=&page=`、详情 `get(slug)`（若有单条端点，否则从 list 缓存取）；originUrl=gitUrl；licenseState=unknown；单测：分页参数、gitUrl 缺失条目的降级
- [x] 1.5 快照失败姿态测试：注入坏响应（throw/畸形 JSON）断言旧快照保留 + stale 标记；TTL 窗口内不发第二次外部请求

## 2. 聚合端点

- [x] 2.1 `server/routes/extensions.js` 挂三路由（沿用现有路由门）：`GET /api/extensions/external/sources`（启用清单+每源健康/stale 态）、`GET /api/extensions/external/search?q=`（Promise.allSettled 扇出、每源 top-N=`EXTERNAL_SOURCE_PAGE_SIZE` 默认 20 上限 50、按源分组）、`GET /api/extensions/external/entry/:source/:slug`
- [x] 2.2 端点测试：单源失败不影响他源组返回；空源组带错误态返回；env 关源后不再出现在 sources 清单且 search 不含该组
- [x] 2.3 只读断言（spec 的只读 Scenario 钉死）：`grep` 级测试——外部路由集中无任何写库/写文件调用；对外部条目无 install/import 端点

## 3. 前端货架

- [x] 3.1 `packages/core` extensions-api 加三个只读方法（sources/search/entry），不改既有方法
- [x] 3.2 `ExtensionsPage.tsx` 加「外部源」tab（默认可见，无 flag）；新组件 `ExternalSourceTab.tsx`：搜索框、按源分组的卡片列表、源徽章、「未经本平台审校」固定标、许可证三态 chip（declared/not-declared/unknown 文案照 spec）、stale 源组顶条（`stale · 更新于 <时间>`）
- [x] 3.3 详情 drawer（复用现有 drawer 形态）：displayName/description/tags/downloads/stars/version+versionLayer、originUrl 外链（`rel="noopener noreferrer"`）、无任何安装按钮
- [x] 3.4 i18n：中文/英文文案成对；「未经本平台审校」「许可证未声明」两条关键文案走 i18n 表（沿 web 一键两用教训，别 inline）

## 4. 验证与上线核验

- [x] 4.1 本地 e2e（Playwright 沿 extensions 既有 harness 约定）：tab 可见性、搜索渲染两源分组、详情 drawer、stale 态注入（mock 坏响应）
- [x] 4.2 lint + typecheck + 既有 e2e 车道无回归（extensions 相关 spec 全绿）
- [x] 4.3 上线核验①：从 prod cheap-* 节点 curl `api.smithery.ai` 可达性；不通则该部署 env 关 smithery（记录到台账）
- [x] 4.4 上线核验②：Smithery 元数据再分发条款核验（读其 terms/API 条款；只读展示+归属徽章为本次依赖的合规底线），结论记 `docs/` 附注
- [x] 4.5 生产冒烟：external/search 真流量、两源条目眼见、三态徽章正确渲染；`EXTERNAL_SKILL_SOURCES=skillhub` 关源演练一次再恢复

## 5. 文档与登记

- [x] 5.1 `docs/` 附注：外部源适配器契约说明 + 源清单 + 上线核验结论（4.3/4.4）；标注刀二预告（安装/多文件/治理知情确认）
- [x] 5.2 更新台账：registry-maintenance.md 运行表若无涉则跳过，但探索底稿（本次四路调研+20 项核验结论）链接进 docs 附注，防证据链断
