# Proposal: add-fleet-core（舰队核心：岗位/组织/物化对账）

## Why

壹座已具备组建自治组织全部的原子能力——persona/动态集群/市场 a2a 三种可调度目标、cron 节奏（时区/漏跑记账/专属会话）、agent 间委托与动作闸——但这些原子之间没有「组织层」：用户无法声明「这是我的舰队、电商是一个岗位、CEO 巡视全队」这样的持续结构，更无法在人员更替（换 persona）、节奏调整、整队暂停之间保持组织记忆连续。本 change 把舰队立为 cell 的一等公民对象，作为后续报数（刀2）、拍板（刀3）、驾驶舱与模板（刀4）机制的唯一底座。

## What Changes

- 新增 **Fleet（舰队）** 与 **Member（岗位）** 两个一等对象及 sqlite 持久化（沿用 clusters.db 的建库模式）：
  - Member 是**稳定的岗位**：title、组织树边（parentId，支持森林）、KPI 槽位声明（kpiSlots）、节奏规格（cadenceSpec：cron/tz/promptTemplate，**可选**——无节奏即被动岗）、以及**可原子替换的在岗者引用** targetRef（persona | cluster | a2a）——换防不换史（ADR-0031）。
  - **唯一在岗**：角色与动态集群全局同时只能占一个岗位；Agent 服务（a2a）可多岗。岗位引用不限制角色的日常对话。
  - **换防语义**：默认继承岗位会话史，换防时可勾选「清史重开」；换防目标若已在别的岗位在岗则拒绝并提示。
- 新增**物化与对账层（reconcile）**：Member.cadenceSpec 幂等物化为 task-engine 的 cron 任务（打 `fleetId/memberId` 标）；编辑节奏、换防、成员增删、全队暂停/恢复/归档都通过对账落到既有引擎 API——**不引入第二套调度器**，task-engine 仍是唯一执行真源。
- 新增舰队 CRUD REST API（`/api/fleets`）：建队/改队/解散（归档）、成员增删改、换防（swap targetRef）、暂停/恢复（舰队级与成员级）、悬空成员（targetRef 指向已删除对象）的诚实降级为「待补岗」态。
- 新增**在岗派生**（on-duty/失联/待补岗为纯派生视图，不落库）：依据物化任务存在且未暂停、执行历史近期有跑、（刀2 落地后）报数未腐化综合派生。
- 新增 web「我的舰队」基础面：舰队列表 + 成员树（平铺树形）+ 成员卡（岗位/在岗者/节奏/状态）+ 编队器简版（选节点、设节奏、建队）；用户面命名就叫「舰队」。
- 悬空与护栏：过密节奏创建时警告确认；归档=全停保史（物化任务批量 pause + 舰队态 archived，历史可读）。

## Capabilities

### New Capabilities

- `agent-fleet-core` — 舰队与岗位对象模型、组织树、物化对账、生命周期（含换防/悬空/归档）、在岗派生、REST API 与基础管理面。

### Modified Capabilities

（无——cron/task-engine/clusters 的既有需求不变；本 change 只以新增调用方身份使用它们的现有契约。）

## Impact

- **代码**：`server/routes/fleets.js`（新）；`fleets.db` 建库模块（新，模式抄 clusters-db.js）；`server.js` 挂路由；`task-engine.js`/`cron.js` 仅需确认任务记录可携带来源标签（若无则加透传字段，不改既有需求）；`web/src/pages/FleetsPage.tsx`（新）+ 路由/i18n/导航（「舰队」入口，避开桌面专属的 /fleet——新路由用 /fleets 或 /org 待 design 定）。
- **兼容**：纯增量，不动现有 cron 任务与集群行为；未加入舰队的 persona/集群零感知。
- **后续刀的接口面**：Member.kpiSlots 与 StatusReport.latest 视图（刀2）、DecisionItem 队列（刀3）、FleetTemplate 清单（刀4）都以本 change 的对象模型为唯一参照。
- **成本**：物化出的 cron 回合照常计费；舰队级暂停即刹车，成员级 usage 归因复用既有 pack-usage。
