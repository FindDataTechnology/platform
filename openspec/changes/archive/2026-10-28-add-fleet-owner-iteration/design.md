# add-fleet-owner-iteration · Design

## Context

- 零件锚点：架构师 dry-run/apply（`fleets.js:745/758`、`server/fleet-architect.js`，对话式、无持久化审批单）；模板导出 `GET /:id/export`（`fleets.js:1162`）；cell 草稿 `POST /api/pack-drafts(+/:id/published)`（`server/routes/packs.js:46-83`）；发布 `POST /api/packs`（`gateway/packs.js:1077`，`pack_versions` 追加不可变）；跟新现状只有 notice（templateNotice banner + MyPacksView hasUpdate）；决策车道 `decision_items` 完整拍板语义。
- 需求书纪律：市场是唯一分发更新通道，走提案+拍板，不直改在册模板。

## Goals / Non-Goals

**Goals:**
- 迭代回路四环（提议→拍板→铸版→跟新）全部复用既有机制接出，持久化对象只有「拍板项+链状态」。
- digest 推送走账内 unread，零外发通道依赖。

**Non-Goals:**
- 零起蓝图编辑（L3，另案）；现役集群自动升级；邮件/IM/微信外发（v1 仅账内，scheduled-task-notifications 模式）；跟新提示的精细偏好屏（频控/静默档可后补）。

## Decisions

- **D1 审批单=拍板项，不建第二张审批表。** 配置改动提议以 `decision_items` 类型扩展承载（diff 附件存条目 detail），批准回调驱动迭代链——决策语义、超时过期、审计一拍即合。备选（独立 change_requests 表）被否：两套审批语义必漂移，且拍板队列恰恰是需求书 B 已立的主人面。
- **D2 迭代链=白名单编排既有段，链状态机最小化。** approved → casting（export→pack-draft）→ publishing（gateway）→ published | failed(axis)。链路只做编排与状态记录，不复制各段校验逻辑；失败轴忠实透传（导出校验/发布门/署名价格规则）。链重试从失败环继续，不整链重跑。
- **D3 vN+1=新主版本号追加，现役集群零触动。** 发版后两条提示链分轨：订阅者账内提示（本单新增）+ 现役集群 templateNotice 强化（变更摘要进 banner）；升级永远显式。备选（提供一键迁移现役集群）被否：违反「模板新版不自动迁移」纪律，v1 连入口都不做。
- **D4 digest=jobs 周期任务 + 账内 unread，内容渲染复用 fleet digest 渲染器。** 订阅关系存 owner 侧小表（fleet, cadence, created_at）；产出走 `fleet-decisions.js` digest 渲染与 KPI 视图组装，投递=scheduled-task-notifications 的 unread 语义。停机补跑由 cron-module 既有 catchUp 机制覆盖，不另造。
- **D5 与 owner-surface 的接法是「入口挂坞面、本体在本单」。** 迭代入口从经营坞进（依赖其坞面落点），但 spec 与链表独立——两单可并行实施、按序归档。

## Risks / Trade-offs

- [拍板项类型扩展撑大 decision_items schema 与队列噪音] → 类型键+附件走 detail JSON，列表渲染对非日常类型做折叠；既有拍板项 schema 不变更、迁移零成本。
- [export 白名单字段与 manifest 校验不对齐导致铸版必败] → 链首环即跑一次发布门的 validate-only（既有「不发布也可校验」能力）做预检，失败前置呈现。
- [digest 周期任务量大刷屏] → 按集群+档位去抖合并（owner 每集群一档一条），退订立即生效；unread 通道既有去重纪律沿用。
- [付费模板的新版本跟新与成交范围冲突（免费看提示但无购买资格）] → 提示可见≠可装：安装闸沿用成交范围语义，提示文案如实呈现形态（升级需成交）。
- [owner-surface 未落地时本单入口无处挂] → 任务切分让链本体（API+状态机）先行，坞面入口为独立收尾任务，两单并行不锁死。

## Migration Plan

1. decision_items 类型扩展+detail 附件+批准回调钩子；既有拍板项回归。
2. 迭代链表与编排器（export→draft→publish），validate-only 预检。
3. 订阅跟新提示：发版钩子→账内 unread；MyPacksView/市场面「有新版」状态强化。
4. digest 订阅表+jobs 任务+unread 投递+退订。
5. 回滚：链与订阅表停用即可，拍板项类型扩展向后兼容（旧类型行无感知）。

## Open Questions

- digest 日/周档的具体时刻（默认 09:00 本地）与集群多时区策略——运营可调，task 切分不受影响。
- 现役集群「显式升级」执行的形态（v1 只到提示；升级执行=重新装作 or 增量迁移）留给后一棒需求裁决，本单不建。
