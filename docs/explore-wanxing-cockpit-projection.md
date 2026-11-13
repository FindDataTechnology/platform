# Explore 报告：萬星侧 cockpit 投影（挂账 ③）

**日期**：2026-10-27 ｜ **状态**：探索收口，待立项（六决策点带建议）｜ **来源**：decision-lane D6 挂账（agent-fleet 四刀）+ ① 四天自然 cadence 观察已证实驾驶舱在自然跑

## 1. 目标

把壹座侧已经活体的**舰队驾驶舱循环**（岗位树/KPI 槽/拍板队列/日报流/健康聚合）投影到萬星控制台，作为舰队机制「萬星机群运营面」的下一步。挂账原文：「萬星侧 FleetView 落 cockpit 投影」（fleet-core design）+「萬星 mission 审批接为同形生产者是后续独立 change」（decision-lane D6）。

## 2. 现状盘点（两仓皆亲眼看过字段级）

### 2.1 传输管道：已建成且在产跑（本次最重要发现）

```
┌─────────── paas (platform pod, gateway) ───────────┐        ┌──────── 萬星 fleet-observer ────────┐
│  gateway/fleet-cells.js 创建 cell fleet reporter    │        │  /ingest (Bearer FLEET_INGEST_TOKEN) │
│  每 30s 采样每个活 cell /api/tasks/stats            │  HTTP  │  store: events 表（kind 枚举白名单）  │
│  身份信道 = x-forwarded-email + CELL_GATEWAY_SECRET │ ─────▶ │  rollup 面（计数）+ raw kind 窗合成   │
│  事件 = { source:"cell-sampler", agent:"cell:<email>",│       │  board 端点 = /api/fleet/v1/board   │
│           kind:"cell_stats", payload:任务统计 }      │        │  OpsView「短期执行」段已渲染 cells[]  │
└───────────────────────────────────────────────────┘        └──────────────────────────────────────┘
```

- 生产 env 已配：`platform.yaml` 带 `FLEET_INGEST_URL/TOKEN`（fd-infra-deploy 核实）；`wanxing-observer.yaml` 带 `FLEET_INGEST_TOKEN`；`wanxing-facade.yaml` 带 `FLEET_OBSERVER_*`。
- **只读、容错、零额外凭据**的既有设计律（fleet-cells.js 头注释 D1/D2）：sample 失败=本 tick 缺席，不重试不重放；cell 无任何新凭据。
- ingest 对 kind 是**枚举白名单**（`EVENT_KINDS.includes` → 未知 kind 400）——新事件品种必须先在萬星仓注册。

### 2.2 壹座侧驾驶舱出口面（已可复用，零新建语义）

- `GET /api/fleets`：fleets[]（name/state/memberCount/statusCounts{onDuty,paused,missing,vacant,passive,failing}）——健康徽章面的原料已经够。
- `GET /api/fleets/:id/cockpit`：单往返聚合（树+槽位达标+派生态+未决拍板 severity→临期排序+日报流+健康）。
- 拍板队列：`GET /api/fleets/:id/decisions?state=open|all` + 五操作（批/驳/改批/重开/execute-now）。
- **四天自然跑的非预期实证**（①观察，10-23→10-27）：CEO68 轮巡逻全诚实（开源部 GitHub 真数据/投资部拒编 pnl）、escalate 防洪闸生效、72h 过期生效、平台滚版被舰队「看见」（runtime_not_running 上报）、a2a 车道可靠性缺口实证（原话见台账）。

### 2.3 萬星侧控制台与 mission 面

- 控制台（wanxing-web，Logto PKCE OIDC）：OpsView（运维面，渲染 board）、FleetView（部署面=pack deployments，非 paas 舰队）、MissionsView（mission 列表+**批准**）、事项面板（matters V2，访客向）。
- mission 状态机（wanxing-facade/missions.js）：`draft→submitted→planning→awaiting_approval/auto_approved→scheduled→executing→reported|failed|aborted`；人审批腿 = `awaiting_approval --(owner/ops)--> scheduled`。 façade store 存 mission 全史，观测走 mission.* 事件进 observer。
- board 已会合成 mission 概览（生命周期 rank 合成 + spent）。

## 3. 候选方向对比

| 方向 | 形状 | 鉴权缝 | 变更面 | 风险 |
|---|---|---|---|---|
| **A1 事件流延伸（推荐）** | paas sampler 新发 `cell_fleets` 事件（每 cell 每 tick 一快照：各舰队 compact）→ observer 注册 kind + 合成 → console 新段 | **零新增**（复用 FLEET_INGEST_TOKEN 与 cell 身份信道，只读 D1/D2 律原样沿用） | paas：cell 内聚合端点+sampler 扩展；萬星：kind+合成+UI 段 | 与 cell_stats 同格——活 cell 缺席即缺席（需 UI 明示 lastSampleAge） |
| A2 拉取代理 | wanxing-facade 按需拉 paas 网关新 admin 读路由 → 缓存 → console | 新跨服务凭据+新攻击面；或 Logto SSO 共享租户验证未证 | 两边各一块中等 | 凭据分发、缓存失效、跨平台会话映射三坑 |
| B 拍板同形生产者 | mission awaiting_approval → paas decision_items（批→写回 façade） | **双向写缝**+身份映射+防重放+乐观并发对撞 | 大 | 为「等等再做的第二件事」，混进 ③ 必膨胀 |

**推荐 A1**：投影的语义是「镜像一个被证明的读面」，不是「在萬星重建拍板通道」。A1 全符合：读面单向、容错采样、凭据零新增、两边变更都可控。

## 4. 六决策点（带建议）

- **D1 方向=A1**（见上表）。若选 A2，停下来重评凭据方案。
- **D2 投影粒度**：**compact 卡**（fleet 名/状态/健康 chips/待拍板数+top3 题面/各岗 latest 一行）+ 深链回 paas `/fleets/:id` 做动作。**不**全量复刻 cockpit 树（采样通道 30s 粒度+payload 有界，复刻亦无新信息）。（建议）
- **D3 休眠 cell 语义**：**只采样活 cell**（与 cell_stats 同律，唤醒采样是隐性税）；meta 带 `sampledAt`，UI 呈现数据年龄并让绝龄卡淡出。（建议）
- **D4 paas 新聚合端点 `GET /api/fleets/overview`**：每 cell 一次调用回全部舰队的 compact 投影（框住 payload 上限，如决策 top3、报告一行槽位）；sampler 不逐贯 cockpit 端点。owner 校验沿用 cell 身份信道，无新审计面。（建议）
- **D5 UI 落点**：**OpsView 新增「壹座舰队镜像」段**（机群总览下，与短期执行段同级）。独立 nav view 是 v2（等 deployer 个人视角诉求出现再拆）。呈现只读+「动作回壹座」深链。（建议）
- **D6 受众=ops 面**：board 现行 gate 是 ops Bearer token——把投影放在 ops 面意味着只有运营方看见（部署者个人不可见。**这是边界与语义的取舍**：若目标是「部署者看自己舰队」，须改走 façade gate 按 `who.email` 过滤（A1 里 agent=cell:<email> 天然可用于过滤），成本高半个 UI。建议 v1 走 ops 面、D6 档位留给后续（与 deployer 卖出舰队生态的时机合流）。（建议）

## 5. 拆分与估算

单 change 双仓配套（先例：E3 ask-bridge/control-surface 两姊妹 style 可在同一 openspec change 内分仓列 tasks，两仓分别出片）：
- **paas（~0.5d）**：`/api/fleets/overview` compact 聚合（有界：health+top3 决策+latest 一行/member）+ fleet-cells reporter 发 `cell_fleets`（可再倍频 60s,失败容错同律）+ 单测+行级文档。
- **fd-wanxing（~1d）**：`cell_fleets` kind 注册（枚举白名单）+ board/`/api/fleet/v1/cell-fleets` 端点（按「每 cell 最新快照」合成，window=样龄≥3×tick）+ OpsView 镜像段（data-testid 齐行）+ e2e stub；`_cells.payload schema 版本化`字段 v。
- **上产**：三镜像（platform / wanxing-observer / wanxing-web，webside 若 façade 无改则 facadeservice 不动）+ GitOps 双端 + OpsView 真镜镜像段眼见（社区种子舰队巡检、enabled 30s/60s 采样转升夜间零问题）。
- **验证（含 live）**：运维面打开 OpsView 眼见「aloadtree 公司式舰队」卡+decision count 与 paas cockpit 一致；杀 fleet 后卡转「数据年龄」提示；圭存 cell 休眠状态不雾告警。

## 6. 风险/开放问题

1. **受众所含隐私文本**：镜像会含 fleet 名/岗位标题/队拍板题面（可能含敏感项目名）随 ops 面暴露给运营 token 持有者——与 cell_stats 同级，但粒度更深；可在 payload 里只留题面前 80 字+按内网运营边界处理（建议 D6 同批中说明）。
2. **schema 演化**：projection payload 版本化字段（v:1)以免后市场旧 observer 端点不兼容新版本 sampler 而失真（observer kind 白名单失败模式已经明示此风险）。（建议带上）
3. **遗嘱事项**：B（拍板同形生产者）留独立 change，在本镜像稳定后再开。
4. 一级开放问题：① deployer（非 ops）是否也有看自己舰队的诉求条目；这决定 D6 在什么时候重评。② `cell:<email>` 泄漏已在 cell_stats 存在，暂不解决。

## 7. 不做（本 change 明确划出）

- 不动 mission 状态机、不动拍板 API、不动任何事项目面板。
- 不做双向写回；不做实时拉取；不做 deployer 视角 admin 普通用户分区。
- 不动 fleet-observer 的 rollup 面（新品种的板读走 raw kind window，与 mission 一例）。

**下一步**：六决策点拍板后→`add-fleet-cockpit-projection` change 立项（paas repo，spec 面新能力；萬星小伴 cut 中新增 tasks 段）→ 双仓实现 → 三镜像上产 → OpsView 真机眼见。
