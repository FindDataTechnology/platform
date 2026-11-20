# 多 agents 并行运行 × 记忆 × 计量 × 自迭代 整体方案调研底稿（agent-parallel-execution）

> 2026-10-31 `/opsx:explore` 收口。**状态：调研完成、未立项**——本文是后续 change 切片的单一事实源。
> 起点命题：用户「现在的 agents 部署后只能串行，这个方案对于多 agents 运行不是很合适，需要有一个整体方案」。
> 过程中用户三次收窄定调：①「我的设想是用户的 agents 决定怎么处理」（平台不做调度器，只给执行单元+派活工具+准入预算）；
> ②「承载这点要可配置」「记账要细致，方便后期优化」；③「记忆的事情和永忆搭配起来」「词元价目应该是现成的」「每个 agent 可自定义构造长期记忆，喂给自迭代方案」。
>
> 伞文档关系：多 harness 运行层归 `docs/wanxing-multi-harness-runtime-explore.md`（切片② pod adapter 已归档，
> 本文直接吃它的 D1 判读）；记忆面真源归 `docs/memory-architecture-v2.md`（ADR-0030），统计面决策出处归
> `docs/memory-and-stats-plane-explore.md`（S1-S5）；编排范式与三层承载归 `docs/fleet-orchestration-scale-explore.md`；
> 产品计划归 `docs/roadmap-agents-native-teams.md`（§4 线5 + §5 自迭代闭环）。本文只管**执行底座 + 闭环整合层**。
> 调研基线：本仓生产代码逐处读证（行号在案）+ dsh 0.2.0-rc.2 上游源码 + sub2api fork 后端路由 +
> fd-memory src 面。

## 命题拆解

1. agents 部署后只能串行 → 要一个整体方案。
2. 用户的 agents 自己决定怎么处理（平台不编排拓扑，提供 actor + 派活工具 + 准入预算）。
3. 承载（跑在哪）要可配置。
4. 记账要细（方便后期优化）。
5. 记忆与永忆一体；词元价目现成或补接口。
6. 每个 agent 自定义长期记忆 → 喂自迭代（单个 agent 与团队都自动迭代）。

## 一、诊断：「串行」是四层叠加，只有一层是物理

```
用户视角：一轮团队回合 = 成员 A → B → C → D …（串行）

① 进程层【物理】  dsh 回合收尾（finish/idle）进程级串行——两会话各持独立 agent 上下文，
                  派发可并发、收尾照样饿死（0.2.0-rc.2 / 0.2.1-a1 双版本实证）。
                  证据：scripts/probe-concurrent-turn-close.mjs；判读订正
                  openspec/changes/archive/2026-10-14-add-dsh-pod-adapter/design.md:9（D1）。
                  推论：真并发 = N 个进程；进程内多会话只给「派发重叠、收尾排队」。

② 平台层【实现】  persona 是进程级单值：桥 agentPreset 在 initialize 烤死（dsh-bridge.js:418），
                  换人设 = restart() 整 child 重启 5-10s（docs/vertical-packs.md:224），
                  每次重启按当前 preset 重建所有会话的 agent 上下文。
                  证据：server/agent-session.js:889 switchPresetToInner → dshBridge.restart；
                  server/cron-runner.js:601-608（persona 成员恒串行的注释）。
                  但桥已有 preset/set（会话级 persona，parked 语义）：
                  dsh-profile-template/platform-preset-bridge.js:26/:338——只有 agent-runner 在用
                  （agent-runner/harness/dsh.js:321），cell 未接。

③ 引擎层【实现】  task-engine 一条 executionQueue 串行链（task-engine.js:440 chainExecution）；
                  唯一并发出口 worker pool（server/worker-slots.js），fd-prod
                  TASK_WORKER_MAX="0"（k8s/deployment.yaml:96-97，注释：4GB 节点塞不下并行 child）。

④ 容量层【预算】  cell pod 硬顶 1536Mi、峰值 1530/1536MB；基座 770-870MB；child 新鲜 117-136MB、
                  重会话 480-540MB、每 active child 另带 55-60MB MCP sidecar
                  → 实际并发 ≈2-3 新鲜 child（docs/facet-wanxing-roadmap.md:194-200）。
                  TASK_WORKER_MAX=0 不是保守，是算不过账。
```

**代价账**（product-intro 六人队一轮）：6 × (5-10s 重启) = 30-60s 纯开销 + 全程队首阻塞 +
轮间用户对话被 waitForIdle 挡。

## 二、承载档位 × 并发语义 × 成本（全图）

```
档位                      并发语义            内存/单元        适合谁
────────────────────────────────────────────────────────────────────────
C0 cell 单 child（现状）   串行 + 每次换人设    共享 130-190MB   单人轻用
                          重启 5-10s
C1 cell worker 槽          真并发（每槽一进程） 190-250MB/槽     小团队快车道
C2 runner solo child       真并发（每 agent     130-190MB/agent  热 agent
                          一进程）
C3 runner pod 共宿（在产）  派发重叠、收尾串行   摊销 1 进程      长尾/温态
                          （①的硬限制）       (floor 160MB)
C4 磁盘会话（cold，在产）  无（有回合才起）    ~0              数百在线但闲
```

规模账：100 全热 solo ≈ 13-19GB（4Gi pod 实测并发 5-6 → 要 ~18 pod ≈ 70-80GB，不可行）；
100 温态共宿（10 pack）≈ 1.6-1.9GB（1 pod，可行）；cold ≈ 0。
**数百 agent「在线」靠 C3+C4 摊密度，真并发只属于少数热单元。**

## 三、路线对比与定案

| 路线 | 机制 | 内存 | 风险 | 买到 / 买不到 |
|---|---|---|---|---|
| A 会话级 persona 入 cell | cell 侧首 prompt 前 `preset/set` park | **0** | 低（桥能力在产，只差接线；`ctx.currentPreset` 40 处读取要改按会话） | N×重启→0；**不给真并发** |
| B cell worker 槽 | `TASK_WORKER_MAX≥2` | +190-250MB/槽 | 中（pod 须抬到 ~2.5Gi；patch 目录 per-worker；drift 放大） | ≤3 真并发；cell 物理封顶 |
| C 团队回合外派 runner | a2a 车道（已在产）+ registry entry + 结算 | cell ~0 | 中高（跨机身份/凭据/回投） | **水平扩**；agent 间 a2a 派活=「agents 自己决定」 |
| D 三层承载落地 | T1 skill 岗走动作闸 | 0 | 中（新执行分支） | 把热单元数量压下来 |
| E 准入与预算 | 波次/超时/并发上限 | ~0 | 低 | 「agent 自由决定」不失控 |

**用户定调（2026-10-31）**：全部要（延迟 + 真并发 + 规模），且「用户的 agents 决定怎么处理」。
对应落地顺序见 §六切片序列；B 路线放最后甚至不做（要动 pod 内存与配额，收益面被 C 覆盖）。

## 四、决策清单（两轮对话定案，用户逐条确认）

### 承载可配（carrier）

- **D1 carrier 是 targetKind 之外的正交维度**：`"cell" | "worker" | "runner" | "auto"`；
  配置三层由细到粗：member.carrier → orchestration.constraints.carrier → 部署默认
  （`CELL_CARRIER_DEFAULT` / `TASK_WORKER_MAX` / `AGENT_RUNNER_POD_MODE`）；解析顺序 member→fleet→部署→auto。
- **D1a auto 判据**（v1 只做前二）：registry 有该员 runner 部署且健康 → runner；cell 有空闲 worker 槽 → worker；
  cell 无在途回合 → cell；其余排队**不失败**（与 pod 纪律一致）。
- **D1b fail-open 降级**：声明 runner 无部署 / 声明 worker 而 cap=0 → 落 cell + 可见告警。
  **永不因配置拒绝一次回合。**
- **D1c 换身体不换会话**：dsh 会话按 id 从磁盘 resume（platform-preset-bridge.js:272 persisted 分支），
  specDrift 加「只改承载不动 task id / 会话」的 diff（fleet-reconcile.js:66 materializedSpec 带上 carrier）。
  **此可移动性的前提是切片①（会话级 persona）先落。**
- **D1d 准入硬闸**：per-fleet / per-cell in-flight 上限（形态照搬上游 `maxActiveSubagents=8`）；
  现状 `spanMax` 只 warn 不拦（fleet-orchestration.js:221）——真预算必须成硬闸。

### 记账细粒度（一回合一行）

- **D2 明细加列**（聚合字段成列建索引，不塞 detail JSON——detail 按行读不按列查，fleets-db.js:341）：
  `carrier + carrier_instance`（分档成本对照）、`preset_id + preset_source`（人格岗开销归因）、
  `provider`（同名模型跨 provider 异价）、`effort`、`cached_input + cache_write`（提示词缓存命中率）、
  `reasoning_tokens`、时相 `queued_at`（派生 queue_wait_ms）/`spin_up_ms`（重启税）/`first_token_at`（ttft）、
  `fallback_trail`、`billing_key_ref + account_id`（谁付钱）、`depth / wave`。
- **D2a 日汇总表** `member_turn_daily`（fleet×member×carrier×provider×model×day 聚合 token/成本/延迟分位）——
  「后期优化」真正要读的表。
- **D2b 保留期（默认值，用户未反对）**：明细维持每成员 200 行 + 30 天（现状纪律），
  日汇总永久——对齐统计面「13 个月滚动 + 每日聚合永久」既有决策。

### 记忆 × 永忆一体

- **D3 统一锚**：turn fact 写永忆时页面头部带
  `turn_id · run_id · member · carrier · model · tokens · status`——「每页记忆都知道自己是谁花的钱买的」；
  台账 `trace_turn_id` 反向链。「搭配起来」的本体即此一跳互查。
- **D3a 事实/观测分流**：**事实跟舰队走，观测跟部署走**——
  事实（五类，低频语义）恒落 `f/<fleetId>`（现状 fleet-memory.js 车道），跨承载合并；
  观测（L0 高频）落各承载 `d/<…>`（runner 照旧），不进舰队命名空间；
  runner 的五类事实镜像 `f/`（带 carrier 标记），L0 不镜像。
- **D3b 换防连续性**：carrier 迁移与岗位 swap 强制走一次永忆 handoff（claim-once 现成）——
  「身体换了，记忆跟着走」；清史改为「交接后清」。顺手治 B2 静默删教训（supply-open 实录）。
- **D3c 记账反哺蒸馏（轻）**：日汇总异常（成本突增 / queue_wait 走高）按周折「舰队成本周报」页进 `f/`，
  作 L2 蒸馏的 L1 源。蒸馏器现成，只加一类输入。
- **D3d 降级开**：capture 永不阻塞回合（fleet-memory.js 既有纪律原样保持）。

### 词元价目

- **D4 现成，平台只补读**：sub2api fork 已有
  `GET /api/v1/admin/channels/model-pricing`、组级价目 map（groups 表）、
  `GET /api/v1/admin/dashboard/*`（趋势/模型/分组/keys 批量）、`GET /api/v1/admin/users/:id/usage`
  （backend/internal/server/routes/admin.go:285-294/:311/:783-784）。
  平台 `lib/sub2api-admin.js`（ADR-0011 唯一门）加 3 个只读方法：
  `readModelPricing` / `readGroupPricing` / `readUserUsage`。不新增写面、不动 fork。
- **D4a 口径（S3/S5 不变，只落细）**：词元永远唯一计费真源；turn 行记 tokens+model+provider+
  `pricing_at`（价目版本戳）**不记钱**；日汇总按词元价目折算并与 dashboard 真数对账（漂移>阈值告警）；
  per-turn 成本语义=「按价目估算」，per-day per-key=词元真数，估算永不混进计费数字。
- **D4b 升级触发**：仅当需要 per-call 成本直读时才在词元开发接口（v1 判断不需要）。

### 自迭代闭环（每 agent 自定义长期记忆 → 自动迭代）

- **D5 自定义落在章程层，不落在格式层**：OKF 页面类型保持规范；每 agent 在 persona/pack 声明
  **记忆章程**（write 哪些类型 / trigger 何时自写 / recall 召回时机与条数 / 自有 tag 词表）；
  章程随 pack 版本走，**章程本身是被迭代对象**。
- **D5a 每员回合前召回梯**：`beforeTurn` 缝（唯一汇合点）扩展注入该员记忆 digest；
  降级三梯照抄 cluster-memory（digest 面 → 标题列表 → 无），**记忆缺席永不阻塞回合**。
- **D5b 记忆→提案桥（三车道各一提案器，不建新机制）**：
  经验页 → skill candidate（evidence=turn_ids+页面链接）；蒸馏出的编排瓶颈 → config-change 提案；
  台账异常（queue_wait 持续高 / 长期空闲低耗）→ tier/carrier 升降提案——**记账是证据源，carrier 提案器是消费者**。
- **D5c 防中毒四闸**（全部借用现成结构）：provenance（author=agent|platform + 来源 turn_id）；
  证据强制（无证据不受理）；评测前置（skill 双臂盲评 / 编排蓝图试跑 / 承载 14 天冷却）；
  人批终闸——**自动迭代 ≠ 自动生效**（三车道结构保证原样）。

## 五、三轴一张图（整体方案的骨架）

```
                同一身份锚：fleet_id · member_id · turn_id
                                │
   ┌────────────────┬──────────┴──────────┬───────────────────┐
   │ 执行承载轴      │      记忆轴          │    计量计费轴       │
   │ carrier 可配    │   永忆 fd-memory     │   词元 sub2api     │
   │ cell/worker/   │  L0观测→L1事实→L2蒸馏│   唯一计费真源      │
   │ runner/auto    │  事实f/ · 观测d/     │   估算≠计费         │
   └────────────────┴─────────────────────┴───────────────────┘
        ①在哪跑            ②记得什么            ③花了多少
                    ↕ ⑥自迭代闭环（三提案车道 + 人批闸）↕
```

## 六、切片序列（未立项，按序；②③④可并行）

```
① cell 会话级 persona        dsh-bridge 加 preset/set wrapper + cron-runner 去
                             switchPresetForJob 改 park + currentPreset 40 处按会话化
                             〔零内存；承载可移动的前提〕
② 台账加列 + member_turn_daily〔量尺先于换身体〕
③ 词元价目接入               sub2api-admin 3 只读方法 + 折算 + 对账
④ 永忆四补丁                 锚 / 事实观测分流 / 换防交接 / 周报
⑤ carrier 配置面             三层配置 + auto 判据 + fail-open + 准入硬闸
⑥ 自迭代闭环                 章程 → 召回梯 → 三提案器（与⑤共享台账证据面）→ 防中毒纪律
```

每步独立可交付。B 路线（cell worker 槽）不单列切片：待 ⑤ 落地后按真机数据决定是否抬 pod 内存开槽。

## 七、未决问题（进 change 设计期再答）

- **U1** 准入预算挂哪层：fleet constraints（spec 面）还是部署 env（运维面）——倾向 fleet 定宽度、env 定绝对上限，两层取 min。
- **U2** runner 五类事实镜像 `f/` 的去重与噪声边界：产物类（deliverable）事实算不算「事实」随行镜像。
- **U3** 记忆章程的存放位：pack manifest 段（版本化、随装走）vs `d/` 首页自述（agent 可自改）——
  倾向 manifest 声明 + d/ 首页缓存自改视图，改动走迭代提案。
- **U4** `current_preset` 事件流的 UI 口径（「运行时默认」→「下个新会话默认」）迁移期兼容。
- **U5** 词元 dashboard 聚合粒度是否够日对账（per-key per-day）——接入时实证，不够再提词元接口单。

## 八、2026-11-08 复测：浏览器车道瘦完之后，剩下的重复份是 cell-server + dsh child

`change slim-browser-lane-footprint`（已归档）把「不承载回合」的浏览器车道从按 cell 复制改成
按 pod 共享，于是 §一 ④ 里的「每 active child 另带 55-60MB MCP sidecar」这条成本项对浏览器
不再成立（现在 pod 级一份，空闲 101–139Mi）。实测口径：

```
kubectl -n fd-prod top pod --containers        # 按容器拆（cgroup 实扣）
  browser-lane   101–139Mi        （sidecar：service + 上游 CLI；chromium 只在有会话时）
  platform       1629–2206Mi      （gateway + N 个 cell 的 cell-server + dsh child）

pod 内 /proc 扫描（RSS，含共享页重复计）
  在跑 cell 每个：procs=2、425–466Mi、browser=0     ← cell-server + dsh child
  全 pod 浏览器进程：1
```

**所以「B 线拓扑瘦身」的剩余标的很具体**：每 cell 的 `cell-server`（约 220–280Mi）+ `dsh child`
（约 140–200Mi），`procs=2`。浏览器那 50+120Mi 已经不在账上。

### 候选路线（**待调研，未决策**；用户 2026-11-08：先记录，等调研后再判）

| 路线 | 要改什么 | 先要解掉的约束 | 收益 | 风险/代价 |
|---|---|---|---|---|
| R0 维持现状 | — | — | 0 | 基线；常驻 cell 数 × ~430Mi |
| R1 cell 内多 dsh child（C1/B 路线） | `TASK_WORKER_MAX≥2`、patch 目录 per-worker、pod 内存抬到 ~2.5Gi | ① 的物理串行**不解**，只是「多进程换并发」 | ≤3 真并发/ cell | 每槽 +190–250Mi；drift 放大；与 §三 定案「B 最后甚至不做」冲突 |
| R2 把 cell-server 职责并入 gateway，只留 dsh child | gateway 承担会话/路由/文件面；cell 目录只留 workspace | 需要「一个 gateway 进程服务多租户」的隔离面（现在是进程边界承担） | 每 cell −220–280Mi，**最大单项** | 隔离面从进程退到逻辑边界，安全面要重做；改动面大 |
| R3 共宿 dsh（C3） | 已有：agent-runner pod 共宿 | ① 回合收尾串行 = 共宿只给「派发重叠」 | 摊销到 1 进程 | 单 cell 交互延迟；不解决 cell 侧 |
| R4 靠休眠摊密度（C4，已部分在产） | `CELL_IDLE_REAP_SECS=3600`、29/32 suspended | 唤醒 8.6–12s 已实测 | 常驻数×430Mi 直接影响 | 冷启延迟；热用户命中率 |
| R5 「回合级隔离」换执行单元 | 未知 | ① 本身（要 dsh 侧或换 runtime 才能解） | 理论上同时拿并发与密度 | 调研性最大，收益最不确定 |

**判据（调研时按这两条量，别先写代码）**
1. 每 cell 边际 MiB × 常驻 cell 数 —— 用上面两条命令复测，别用 RSS 口径（共享页会重复计）。
2. 它换来什么：R1 换并发、R2 换密度、R4 换密度且不换并发。**先答「要并发还是要密度」**，
   再选路线——这也是 §三 定案里 B 路线被排到最后的原因。
3. 任何路线都要先过 ①：一个 dsh 进程同一时刻只能跑一个回合（`scripts/probe-concurrent-turn-close.mjs`
   双版本实证），所以「减进程」和「加并发」在 R1/R3 上是对立的。

### R2 可行性清单：进程边界现在承担什么（逐条对位代码）

R2 的想法是「cell-server 职责并入 gateway，pod 内只留 dsh child」。它省的是每 cell
220–280Mi，但要拿**当前由进程边界免费提供的东西**去换。逐条对位后，结论是：
**R2 不是「搬代码」，是把一个单租户进程改造成多租户运行时**，且崩溃域会退化。

| # | 维度 | 今天谁保证 | R2 需要什么 | 判定 |
|---|---|---|---|---|
| 1 | 数据根（文件面） | 每个 cell 进程一个 `PLATFORM_DATA_DIR`／`AGENT_WORKSPACE`，spawner 注入 | 所有路径改成按租户传入：**34 个文件在导入期就 `const X = process.env…`** 捕获（`paths.js:17`、`db.js:20 DEFAULT_DB_PATH` 是其中两个代表） | **需重做（面最大）** |
| 2 | store 目录常量 | `storeDir()` 在模块顶层算死：`server/owner-groups.js:13`、`server/routes/files.js:19 UPLOADS_DIR`、`task-engine.js:19 TASK_STORAGE_DIR`、`llm-providers.js:28/:29`、`skill-materialize.js:32` | 每个常量都要变成 per-tenant 实例；仓库里**没有** `createX({root})` 工厂先例可抄（grep 无命中），属净新增模式 | **需重做** |
| 3 | SQLite 句柄与事件循环 | 每 cell 一个进程 = 一个事件循环，同步 `better-sqlite3`（**37 个模块**）阻塞只影响自己 | 单进程要开 N 套句柄，**同步查询会在同一 loop 上串行**：一个租户的慢查询/大迁移会卡住所有人的 HTTP | **会退化（架构级）** |
| 4 | 内存上限 | 已经是 **pod 级 cgroup**（4Gi），一个 cell 泄漏不会单独爆，是整 pod OOM | 无需改 | **不变（本来就没按 cell 隔离）** |
| 5 | 崩溃域 | 一个 cell 崩只死自己，gateway 记账后重生（`gateway/index.js:584 live = registry.cells.get`） | 单进程里任一租户的未捕获异常/内存越界**打死全部 cell**；要靠 per-request 兜底 + domain 隔离补，但补不回进程级硬隔离 | **会退化（不可逆）** |
| 6 | 身份与凭据面 | cell 只信 gateway：`CELL_GATEWAY_SECRET` + `forward_auth`，跨进程传 `x-cloud-gateway-secret` | 边界消失 → 头信任没了对手方，反而**少一个伪造面**（这条是加分） | **改善** |
| 7 | dsh child 生命周期 | 每 cell 一份 `dsh-bridge` + `agent-session`，`server.js:639 ensureCredentialsStore({cellOwnerEmail})`、`:1123 db.initDb()` 都是导入/启动期一次 | 要变成 N 个 bridge 会话对象 + 一个进程内的重启/退避状态机；且 ①回合收尾串行仍是物理约束 | **需重做 + 不解 ①** |
| 8 | 定时器 / cron | `server/cron-runner.js` 在 cell 进程内跑（`activeTurns`、`readyRetryByJob` 都是模块级 Map） | 单进程要一个按租户分片的调度器，且不能互相饿死 | **需重做** |
| 9 | 长连接 / WS | 每 cell 自己的 WS 升级（`proxyUpgrade`） | 单进程多租户 WS 路由 + 会话归属校验 | **需重做** |
| 10 | 生命周期与清理 | **13 处** `process.on("SIGTERM"/"exit")` / `process.exit()` 假设「一个进程 = 一个租户」 | 租户级启停不能用进程信号，要自建生命周期 | **需重做** |
| 11 | 可观测性 | 日志前缀 `[cell <hex>]` 来自 spawner 的 stdio 转发；内存面按 cwd/cmdline 归组（`lib/proc-memory.js`） | 单进程后 cwd/cmdline 不再区分租户 → 内存面**归组机制失效**（正是我这次改的那套），要改成按句柄/按租户记账 | **需重做（观测面）** |

**底线（给调研用）**：R2 买到「每 cell −220–280Mi」，付出的是 ① 11 个维度里 8 个要重做、
② 事件循环串行化、③ 崩溃域从 cell 放大到 pod（不可逆）、④ 观测面归组失效。
而 §三 定案里 B 路线（R1）被排到最后的原因正是「要动 pod 内存与配额」——R2 比 R1 动得更多。
**若目标是密度**，更便宜的顺序是 R4（休眠摊密度，已部分在产）→ 再看 R2；
**若目标是并发**，R2 帮不上（不解决 ①），该走 R1 或 R3。

### R4 可行性清单：靠休眠摊密度（**先走这条**）

R4 不改架构，只动「谁常驻、谁休息、醒来多快」。代码层已经很完整，缺的是**口径**而不是机制。

| 维度 | 现状（代码坐标） | R4 能做的 | 代价 |
|---|---|---|---|
| 回收窗口 | `CELL_IDLE_REAP_SECS=3600`（1h）；`reapIdle()` 到点 `stop()`（`spawner.js:688-720`） | 收窄到 10–20min：常驻数≈活跃数，密度立刻上一个档 | 冷启命中变多；唤醒 8.6–12s（已实测） |
| 策略分层 | `policy ∈ {always, on_demand, ephemeral}`（`spawner.js:85/:264/:526/:711`） | 给「热用户」标 `always`，其余 `on_demand`——**已经有**，只差运维口径 | 无（纯配置） |
| 定时工作不被饿死 | 有 registryDb 时 `on_demand` **不豁免**排期任务——由 duty-ring 负责叫醒（`spawner.js:703-712` + `duty-ring.js:37`） | 无需改：休眠不再是「错过排期」 | 无 |
| 唤醒准入 | `memoryAdmissionVerdict` + 归档足迹（`spawner.js:458-500`），不够就**先驱逐最闲的**再放行（`evictUntilAdmissible`，`:520-560`） | 阈值 `CELL_MEMORY_ADMISSION_FLOOR` 可随 R4 下调后的水位重算 | 阈值偏高会「拒醒」；偏低会 OOM |
| 唤醒延迟构成 | `evictUntilAdmissible` → `freePort` → `mkdir` → `spawn` → `waitForPort`（`spawner.js:382/:46-64`，200ms 轮询）+ cell 自身 boot（含 OIDC discovery，已加瞬态重试） | 想再快只有两条：**预热池**（现在**没有**：grep `prewarm|warmPool|spare` 零命中）或「停车保壳」 | 预热池=常驻成本回来了，与 R4 目标冲突；停车保壳需要新的生命周期动词（现在只有 stop/spawn） |
| 观测 | 本轮刚做的 `browserLane` 行 + `cells[]`（`/api/monitoring/memory`）；`suspended` 计数可见 | 加「常驻/挂起/唤醒次数&耗时」三个计数即可判 R4 是否划算 | 小 |

**判据**：R4 的收益是**线性**的（少 N 个常驻 ≈ 省 N×430Mi），成本是**每次唤醒 8.6–12s + 一次全量 boot**。
所以唯一的决策变量是「**用户多久回来一次**」——`lastUserTrafficAt` 与 `lastDutyRunAt` 已经在
`cell_registry` 里按 cell 落账，**跑一次分布就能定阈值**，不需要写新代码：

```
SELECT cell_id, owner_email, state, policy,
       (strftime('%s','now')*1000 - last_user_traffic_at)/1000 AS idle_s
FROM cell_registry ORDER BY idle_s DESC;
```

- 若多数 cell 的 `idle_s` 已 > 1h 且用户回访间隔远大于唤醒延迟 → **直接把阈值降到 600–1200s，R4 收工**
- 若回访频繁（< 5min 间隔）→ 降阈值只会让用户反复吃 8.6–12s，**此时才需要预热池**，而预热池常驻成本又会吃掉 R4 的收益 → 转去问「要不要花 R2 的代价换密度」

**2026-11-08 实测：R4 已经做完，没有可收割的量。**

```
cells: 32   { suspended: 29, running: 3 }
有流量记录：9 个；从未有过流量：23 个
idle 分钟：p50=2688（≈45h） p90=16394（≈11 天）
running 的三个：2b043ce0 idle=0m / 1da519d4 idle=0m / 3fdc7b8e(platform-test) idle=373m
```

读法：
- `CELL_IDLE_REAP_SECS=3600` 已在正常工作 —— 29/32 挂起就是它的产出，**再降阈值几乎没有可收的**；
- 唯一「常驻但已冷」的是 `platform-test`（6h 无流量，约 430Mi），但它是走查用的测试号，收掉等于下次走查先吃 8.6–12s 冷启；
- 23 个 cell 从未有过流量，本就不占内存（suspended ≈ 0）。

**结论：R4 不是待决策项，它已是最优形态。** 想再省只能动「常驻那几个的单体大小」→ 回到
R2（每 cell −220–280Mi，但要重做 8 个隔离维度 + 崩溃域退化）或 R1（换并发不换密度）。
也就是说：**靠调度省不出更多了**，要不要动取决于你是否接受 R2 的代价，而不是取决于阈值。

> **2026-11-08 晚补**：上述结论只对「调度类」（R4）成立。真按进程逐个算下来，比 R2 更靠前的一刀是
> **R6：MCP 卫星按 dsh 复制**（每实例 ≈450Mi 实扣，见本节末 R6）——它不动进程模型、不牺牲崩溃域，
> 收益还比 R2 大。R2 那句「每 cell 425–466Mi」也应按 R6 的口径重算（单 cell 含卫星 ≈0.9–1.1Gi）。

### R6 候选：MCP 卫星按 dsh 复制（≈450Mi 实扣/实例）—— 比浏览器车道大 2.6 倍

浏览器车道瘦完之后，下一块**按实例复制的**东西是 MCP 卫星。实测（fd-prod，2026-11-08）：

```
一个 dsh runtime 的子进程 = 14 个（13 个 MCP + 1 个 index.js）
  actions-mcp 75Mi ×2 / fleet-mcp 77Mi / delegation-mcp 77Mi / cron-mcp 74Mi
  library-mcp 70Mi / fleet-architect 68Mi / blueprint-author 68Mi / pack-author 68Mi
  persona-evolution 66Mi / skill-evolution 65Mi / bench-proposal 65Mi / websearch 66Mi
全 pod：52 个卫星 = 13×4（3 个主 bridge + 1 个 worker 槽），ppid=1 的孤儿 = 0
```

- **每个 dsh 连同它的卫星 ≈ 930Mi 标称 / 约 450Mi 实扣**（RSS→cgroup 比 ≈0.48）。
- **实测已落地（2026-11-09，`share-mcp-satellites-per-cell` 已归档；scratch / `default` ns，
  同镜像 + 线上真实 mcp.json + 真池派发 `TASK_WORKER_MAX=2`）**：
  - 3 个 dsh（主 + 2 worker）：关共享 **42 颗卫星 / 2848Mi**，开共享 **26 颗 / 1814Mi**
    → **省 16 颗 / 1034Mi 标称（≈500Mi 实扣）**，正好 2×(8 颗共享集)。
  - 规律：**省 = 8 ×（dsh 数 − 1）** 颗。本舰队共享集 8 颗 = fleet/cron/delegation +
    blueprint-author / fleet-architect / pack-author / persona-evolution / skill-evolution；
    `bench-proposal` 因 `envRefs`（BENCH_*）被守卫排除，`actions`/`library`/`websearch` 保持 per-runtime。
  - 对容量决定的意义：开一个 worker 槽，共享前 ≈+995Mi 标称、共享后 ≈+430Mi 标称
    （≈+210Mi 实扣）——**门槛降到原来的一半以下**，但降不到 0。
- 对照：浏览器车道当年省下的是 **~170Mi/cell** → 卫星是它的 **2.6 倍**，且**每个 dsh 一份**
  （开 worker 槽就翻倍），所以 `TASK_WORKER_MAX` 实际是「每个槽 ≈ +450Mi」的开关。

**耦合面（决定可不可共享）**——grep 结论，设计期需复核：

| 维度 | 现状 | 含义 |
|---|---|---|
| 数据根 / DB 句柄 | 13 个卫星里**只有 `library-mcp` 出现 2 处** per-cell 路径引用，其余 0 | 多数卫星**不直接持有** per-cell SQLite/凭据 |
| 真正的耦合 | 全部通过 **env + 回打本 cell 的 HTTP**：`ACTIONS_MCP_URL` / `FLEET_MCP_URL` / `CRON_MCP_URL` / `DELEGATION_MCP_URL`，缺省 `http://${HOST}:${PORT}`；另有 `DSH_SESSION_ID`、`LIBRARY_PROJECT_ID`、`LIBRARY_COLLECTIONS` | 共享进程需要**按调用方解析出"我是哪个 cell"**，而不是各持一套库 |
| 隔离面 | 与浏览器车道不同：卫星会把**代表该 cell 的写操作**回传给 cell server（含凭据/DB 写） | 共享后一旦判错 cell，就是**跨租户写**，比浏览器串 cookie 严重 |

**三条候选路线**

| 路线 | 做法 | 收益 | 风险 |
|---|---|---|---|
| S1 只共享无状态者 | 把 actions/fleet/cron/delegation/bench-proposal/blueprint/pack/persona/skill 这类"纯转发"卫星做成 pod 级一份，按调用方注入 `*_MCP_URL` | 每 dsh −9×(65–77)Mi ≈ −630Mi 标称 / **−300Mi 实扣** | 需一套"调用方→cell"的可信解析（浏览器车道已有同款：socket→pid→cwd）；判错=跨租户写 |
| ~~S1 已实施~~ | **已按更窄的形态做完（`share-mcp-satellites-per-cell`，2026-11-09 归档）**：不做 pod 级、按调用方解析 cell，而是 **cell 内一份**（天然无跨租户风险），dsh 按 url 接入 | 实测 3 dsh **42→26 颗 / −1034Mi 标称**；省 = 8×(dsh−1) | 无需"调用方→cell"解析：宿主属于该 cell，越界不可能 |
| S2 池化 + 按会话绑定 | 池内 N 个共享卫星，会话首次调用时绑定 cell，未绑定即拒 | 同上，上限更硬 | 生命周期/回收复杂；绑定错误仍致命 |
| S3 维持现状 | 不动 | 0 | 每 dsh 约 450Mi 实扣；开 worker 槽即翻倍 |

**判据（调研时按这三条量）**
1. 真实收益要用**实扣**口径算（标称会高估一倍）：单 dsh ≈450Mi，4 个 dsh 就是 ≈1.8Gi —— 正好是
   今天这台 4Gi pod 被顶穿、导致唤醒被拒的那部分。
2. 与 R1/R2 的关系：R1（多 dsh 换并发）**会放大**这块成本（每槽 +450Mi），所以「要并发」必须先
   答「卫星怎么共享」，否则并发一开就撞内存闸。
3. 与浏览器的差别是**写面**：浏览器串的是 cookie，卫星串的是**写动作**。S1/S2 都必须先有
   "可信调用方→cell"的绑定，浏览器车道那套（peer → cwd → 16-hex）可直接复用。

**状态：待调研，未决策。** 这一条比 R2 更靠前：R2 是「省 220–280Mi 但牺牲崩溃域」，R6 是
「省 300Mi/实例且不动进程模型」——先做 R6 的风险-收益比更好，但它需要一次独立的设计。

## 附：本文引用的实证坐标

- R6 口径（§八）：一个 dsh 的 14 个子进程与 65–77Mi 逐个实测；全 pod 52 卫星 / ppid {87,531,1230,1467} /
  orphan 0；耦合 grep = `server/{actions,fleet,cron,delegation,library}-mcp.js` 的 `*_MCP_URL`+`HOST:PORT`
  回退、`DSH_SESSION_ID`、`LIBRARY_PROJECT_ID/COLLECTIONS`；`TASK_WORKER_MAX=2`（GitOps）vs `"0"`（本仓设计清单）。
- R4 口径（§八）：`gateway/spawner.js:688-720`（reapIdle）、`:703-712`（on_demand 不再豁免排期）、
  `:85/:264/:526/:711`（policy 三值）、`:458-500`（memoryAdmissionVerdict + 归档足迹）、
  `:520-560`（evictUntilAdmissible）、`:382` + `:46-64`（waitForPort，200ms 轮询）；
  `gateway/duty-ring.js:37`（挂起 cell 由 duty-ring 叫醒）；预热池 grep 零命中（现在没有）。
- R2 隔离面清单（§八）：34 个文件导入期捕获 env（`paths.js:17`、`db.js:20`）；模块顶层 `storeDir()` 常量
  5 处（`server/owner-groups.js:13`、`server/routes/files.js:19`、`task-engine.js:19`、`llm-providers.js:28/:29`、
  `skill-materialize.js:32`）；`better-sqlite3` 同步用户 37 个模块；13 处 `process.on("SIGTERM"/"exit")`；
  gateway 代理面 `gateway/index.js:584/:647/:696`；cell 启动期单例 `server.js:639/:1123`。
- 2026-11-08 复测（§八）：`kubectl -n fd-prod top pod --containers`（browser-lane 101–139Mi /
  platform 1629–2206Mi）+ pod 内 /proc 扫描（在跑 cell 每个 procs=2、425–466Mi、browser=0；全 pod 1 个浏览器进程）。
- 串行四层：scripts/probe-concurrent-turn-close.mjs；archive/2026-10-14-add-dsh-pod-adapter/design.md:9；
  dsh-bridge.js:418；server/agent-session.js:889；server/cron-runner.js:601；task-engine.js:440；
  server/worker-slots.js:40；k8s/deployment.yaml:96；docs/facet-wanxing-roadmap.md:194-200；docs/vertical-packs.md:224。
- 会话级 persona 现成件：dsh-profile-template/platform-preset-bridge.js:26/:338；agent-runner/harness/dsh.js:321。
- 承载/密度：agent-runner/config.js:154-170（budget 3072 / podCost 160 / podMaxInflight 1）；docs/wanxing-multi-harness-runtime-explore.md:38-39。
- 编排/准入：server/fleet-orchestration.js:216-222；docs/fleet-orchestration-scale-explore.md:74（T1/T2/T3）。
- 记忆/统计：server/fleet-memory.js:1-23；agent-runner/memory-capture.js:7-10；server/cluster-memory.js（三梯）；
  docs/memory-and-stats-plane-explore.md（S3/S5）；fd-memory src/mcp.ts:125-240（八工具含 memory_write_page）；
  fd-memory src/distill.ts（supersede-not-delete）。
- 提案车道：server/skill-evolution.js:1-15；server/fleet-iteration.js:1-20；tier-promotion（10-30 上产）。
- 词元：lib/sub2api-admin.js:1-23；~/finddata/sub2api backend/internal/server/routes/admin.go:285-294/:311/:783-784。
