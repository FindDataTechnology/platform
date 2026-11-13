## Why

集群「跑得怎样→改蓝图/配置→发新版→订阅跟新」的迭代回路目前只有内部 harness 在跑，客户面无入口（需求书 `docs/fleet-owner-surface-requirements.md` D；日报/周报订阅推送同书 B 的缺口一并承担）。零件都在——架构师 dry-run/apply、fleet export、pack_versions 追加、templateNotice、decision lane——但没成环：无持久化审批单、无「已批改动铸成 vN+1 发版」的入口、订阅者与现役集群都得不到跟新提示的账内通道。「市场是唯一分发更新通道」的纪律要延伸到主人面：走提案+拍板，不直改在册模板。

## What Changes

- **配置改动提议型拍板项**：主人/架构师侧的配置改动提议（带 dry-run diff 附件）进既有拍板队列，批准为唯一生效通道，审计天然闭环。
- **迭代链成环**：批准后的改动一键铸成模板新版 vN+1 并经市场发版（export→pack-drafts→publish 白名单链）；链状态对主人可读、每步失败如实分类。
- **订阅者跟新提示**：市场发新版后，pack 订阅者得账内提示（账内 unread 通道，复用 scheduled-task-notifications 模式）；不自动升级、不自动迁移现役集群（既有纪律不动）。
- **日报/周报订阅**：主人可按集群订阅报数 digest（日/周档），经 jobs 周期产出并账内 unread 提示，可退订。

## Capabilities

### New Capabilities

- `fleet-owner-iteration`: 迭代回路（提议→拍板→再铸 vN+1→发新版→跟新提示）与报数 digest 订阅。

### Modified Capabilities

- `agent-fleet-decision-lane`: 新增配置改动提议型拍板项（diff 附件+批准后动作回调）。
- `pack-marketplace`: 新增订阅跟新提示（发新版→订阅者账内提示，不触发自动升级）。

## Impact

- **后端**：`server/routes/fleets.js`/`fleets-db.js`（提议型拍板项 + 迭代链状态）、`server/fleet-architect.js`（diff 附件来源）、cell `server/routes/packs.js` pack-drafts 与 gateway `gateway/packs.js` 发布链编排、jobs 引擎 digest 任务。
- **前端**：坞面迭代链入口与状态呈现、市场面跟新提示、订阅管理小面。
- **依赖**：坞面入口落点依赖 `add-fleet-owner-surface`；跟新提示的消费侧读数与 `add-market-revenue-share` 成交记无耦合（提示对免费/付费条目同轨）。
- **明确不在范围**：零起蓝图编辑/审批闸（L3 构造器，finddata 另案）；现役集群自动升级（永远提示、永不迁移——`agent-fleet-templates` 既有纪律）；外发推送通道（邮件/IM，v1 仅账内）。
