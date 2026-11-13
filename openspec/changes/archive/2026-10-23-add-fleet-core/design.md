# Design: add-fleet-core

## 决策总览

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 岗位与人分离 | Member 稳定行 + 可换 targetRef | 「持续维护」的机制保证：换 persona 不换史；KPI 槽位/报数序列（刀2）/拍板归属（刀3）都锚在岗位 |
| D2 | 执行真源 | task-engine 唯一；reconcile 只做物化 | 不造第二调度器；漏跑记账/时区/专属会话/并发策略全部白得 |
| D3 | 存储 | sqlite 新库 `fleets.db`（模式抄 clusters-db.js） | 既有先例（clusters.db）；与任务引擎存储解耦 |
| D4 | 组织树形状 | 森林（多根）+ parentId 单父边 | 兼容无 CEO 的平铺舰队与多主管结构；成环在写路径拒绝 |
| D5 | 在岗/失联/待补岗 | 纯派生不落库 | 消除状态同步债；判定依据（上次执行/容忍窗口）随响应携带 |
| D6 | 前端路由 | `/fleets`（用户面「舰队」） | 避开桌面专属 `/fleet`（desktop-fleet-console，IS_DESKTOP 门控）；spec 名 `agent-fleet-*` 避开 `desktop-fleet-*`；「舰队」词义归组织概念，runner 侧改称「机群」（CONTEXT.md 已落词条） |
| D7 | 节奏下限 | 创建时 <10 分钟间隔需确认（前端确认 + API `confirmed=true` 透传） | 成本护栏，不硬禁止 |
| D8 | 唯一在岗 | persona/cluster 全局唯一岗；a2a 可多岗（ADR-0031） | 报数归属无歧义；a2a 外部执行无归属问题 |
| D9 | 换防语义 | 默认继承会话史 + 可选清史重开；换防到已在岗对象拒绝 | 组织记忆连续为默认；清史是主人显式决策；自动腾挪旧岗是隐式副作用，不做 |
| D10 | 被动岗 | cadence 可选，无节奏=被动岗（不物化、不失联、被委托/拍板唤醒） | 「按需岗」真实存在；强制节奏=强迫烧钱 |

## 对象模型

```
fleets   { id, name, ownerEmail, state: active|paused|archived, createdAt, updatedAt }
members  { id, fleetId, title, parentId|null, targetKind: persona|cluster|a2a,
           targetId, kpiSlots: JSON[{key,label,unit,showDelta?}],
           cadence: JSON{cron, tz, promptTemplate, enabled},
           sortKey, createdAt, updatedAt }
```

- `kpiSlots` 刀1 只存不渲染卡片（刀2 消费）；编队器允许留空，模板（刀4）会带默认槽位。槽位可带可选 `target`（目标值，刀4 驾驶舱渲染达标色）。
- `cadence` 可为 null（被动岗，D10）；有值时 `promptTemplate` 刀1 为纯文本，刀2 引入 `{{fleetContext}}` 插值——字段形状现在就按模板语义定义，避免刀2 迁移。
- targetRef 校验：persona 查 catalog、cluster 查 clusters.db、a2a 查目录 a2a 条目；三类都不可达时写路径拒绝（待补岗只来自「事后被删」，不来自「建时就悬空」）。唯一岗校验（D8）在建岗与换防写路径生效：persona/cluster 已在任一岗位 → 拒绝并带现有岗位名；a2a 豁免。

## 物化与对账（reconcile）

物化产物 = 引擎 cron 任务，绑定规则：

- `preset` 字段：persona 岗位直接放 persona id；cluster 岗位放 clusterId（引擎既有 cluster 绑定）；a2a 岗位走 delegation 的 a2a 目标语法（与 agent-delegation-a2a 同形）。
- 任务记录新增透传标签 `sourceTag: { fleetId, memberId }`（task-engine 现无此字段，需加一个可选透传列，load/save/serialize 原样携带——不触碰任何既有需求）。
- 对账入口：建岗/改节奏/换防/删岗/暂停/恢复/归档后同步执行；实现为「读该 fleet 全部 sourceTag 任务 → 与成员期望集 diff → 增/改/停」。幂等性由 (fleetId, memberId) 唯一定位保证。
- 换防 = 更新 targetRef + 对账更新物化任务的 preset 绑定（引擎任务 id 不变 → 专属会话延续，历史天然连续）。
- 全队暂停：批量 pause 物化任务（沿用引擎 pauseJob 语义）；成员级暂停优先——恢复全队时被单独暂停的岗位保持暂停（两层暂停位：fleet.state 与 member.cadence.enabled，物化任务的 paused 只跟随两者之或）。

## API 面（/api/fleets）

```
GET    /api/fleets                       列表（含派生概览）
POST   /api/fleets                       建队 {name}
GET    /api/fleets/:id                   详情（树+派生态）
PATCH  /api/fleets/:id                   改名/暂停/恢复/归档
DELETE /api/fleets/:id                   解散（归档+删除物化任务，保留历史行）
POST   /api/fleets/:id/members           建岗
PATCH  /api/fleets/:id/members/:mid      改岗（title/parentId/cadence/kpiSlots）
POST   /api/fleets/:id/members/:mid/swap 换防 {targetKind,targetId,freshSession?}
DELETE /api/fleets/:id/members/:mid      删岗（停物化任务）
POST   /api/fleets/:id/members/:mid/pause|resume  成员级暂停
```

鉴权与 resolveUser 语义抄 clusters.js（auth-off 归机器主人）；ownerEmail 归属校验在每条写路径。换防（D9）：`freshSession=true` 时清岗位专属会话史重开（报数史不动）；目标已在岗 → 409 带现有岗位名。

## 在岗派生算法（读时计算）

```
passive  : cadence 为 null
stale 窗口 = max(2 × 周期, 6h)
on_duty  : 有节奏 ∧ 物化任务存在 ∧ 未被两层暂停 ∧ (有执行 ∈ stale 窗口 ∨ 尚未到首跑时刻)
missing  : 有节奏 ∧ 物化任务存在 ∧ 超过 stale 窗口无执行 ∧ 已过首跑时刻
vacant   : targetRef 解析失败（对象已被删）
paused   : 有节奏 ∧ 两层暂停任一为真
（被动岗失联不适用；其最近唤醒执行可查）
```

响应携带判定依据（lastRunAt、staleWindowMs、nextRunAt）供 UI 展示「为什么失联」。

## 前端

- `FleetsPage.tsx`（`/fleets`）：列表 + 树形成员卡（岗位名/在岗者/节奏人读/派生态徽章）+ 编队器对话框（目标选择复用 AgentsPage 的目录读取）+ 换防/暂停/归档操作。
- 导航入口「舰队」进主侧栏（角色布局白名单同步：sections.ts/surfaces.ts/resolvedLayout 三处——设置分节三处同源是既有坑，导航项同理）。
- i18n 双语；不依赖桌面环境（与 FleetPage 的 IS_DESKTOP 门无关）。

## 风险与对策

- **task-engine 加透传字段**：唯一触碰既有模块的点，保持可选字段 + 全链路透传测试（load/save/serialize/broadcast 四处），既有任务不受影响。
- **换防竞态**：swap 与正在执行的回合并发——物化任务更新走引擎单写者；在途回合自然跑完，下一轮生效（不做抢占）。
- **a2a 岗位的执行语义**：a2a 目标经 delegation 车道执行（persona-less）；报数归属（刀2）按「回合发起的岗位」记账，细节在刀2 design 展开。
- **命名冲突**：spec 前缀 `agent-fleet-*` vs 既有 `desktop-fleet-*`、`fleet-observability`（萬星仓，互不相干）；用户面「舰队」在 web 无冲突。

## 测试策略

- 模块级：reconcile 幂等（重复对账零变更）、改节奏不产孤儿、两层暂停语义、成环拒绝、越权拒绝、非法输入拒绝。
- 活体级：真建队 → 物化任务在 /tasks 可见且带舰队标 → 换防后历史连续 → 删 persona → 待补岗 → 补岗恢复（aloadtree 生产走查口径）。
- 回归：既有 cron/集群任务零扰动（load 后 schedule 行为不变）。
