# Design: add-facet-version-history

## Context

后端事实（见 proposal Why）：`pack_versions` 行级不可变存储、`GET /api/packs/:id/versions`
列表与 `/:versions/:v`（+`/skills/:skill`）逐版取都在产；谦面壳经 `@/*` 别名直通壹座
`web/src`（`facet/web/tsconfig.json`），`PackMarketView` 树已被双壳共用；`#/mine` 已有
本地版本行（`MineView.tsx` 的 `toggleVersions`）。缺口纯在公共 detail 的披露面与
notes 字段契约。

## Goals / Non-Goals

**Goals**：单一版本列表组件服务三面（壹座市场 detail、谦面市场 detail、谦面 `#/mine`）；
notes 零迁移落库；懒加载不膨胀 detail 默认载荷。

**Non-Goals**：旧版本安装动作（只读）；独立 draft 编辑器（PackDraftsView）的 notes 输入
——v1 留给一键流确认步与裸 manifest 两条路；CLI update（F2.3）。

## Decisions

1. **共享组件建在壹座树**（`web/src/components/packs/`，文件名实施时定）：谦面经既有
   别名同享，不新建 facet 侧副本。备选=组件各写一份（弃——两面漂移正是本 change 要消的）。
2. **notes 骑 `pack_versions.manifest` JSON 顶层字段**：行本就不可变，零存储迁移、零新端点。
   备选=独立列（弃——为不可变数据加迁移无收益）。
3. **懒加载 = 客户端按需调既有 `listPackVersions`**：打开披露才 fetch；服务端不动。
4. **校验落发布门（`gateway/packs.js`）并镜像到 cell 安装路径**：spec 既定「install path
   enforce the same rules」——找到与发布门共享/镜像的校验点同步加，防双验证器漂移。
5. **逐版链接直用现有端点**：manifest 快照 `/api/packs/:id/versions/:v`、技能正文
   `/api/packs/:id/versions/:v/skills/:skill.md`，与 detail 现有链接同构。
6. **i18n**：新 UI 文案五语齐（`check-locales.js` 门会拦），壹座与谦面 locale 副本都要落
   （谦面 i18n 双副本坑在册）。

## Risks / Trade-offs

- [detail 载荷膨胀] → 披露默认折叠 + 打开才 fetch（spec 已锁）；版本行不内嵌技能正文。
- [双验证器漂移（发布门 vs 安装路径）] → 同一任务内两处同步改 + 各自单测。
- [PackDetailDialog 已 475 行] → 版本区收敛进共享组件，dialog 只留披露挂点。
- [五语漏翻] → `check-locales.js` 作为完成验证的一部分跑。

## Migration Plan

无存储迁移。部署 = 常规镜像滚动（壹座 web + 谦面 web 双镜像，gateway 同滚带校验）；
回滚 = revert 三处同滚即可，旧数据无 notes 照常渲染（note-when-present）。

## Open Questions

（无——组件命名与披露交互细节属实施自由度，不影响 spec 与任务分解。）
