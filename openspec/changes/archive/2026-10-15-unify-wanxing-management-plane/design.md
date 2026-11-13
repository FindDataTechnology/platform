## Context

切片①-④ 已收：合同护栏（⑩-⑭）、DshPodAdapter、HarnessAdapter+第二 harness（ACP）、谦面物化器。
本切片是萬星多 harness 线终章——管理面统一。现状盘点（2026-10-15 两路 explore）：

- 常驻面：registry entry metadata 全维度（paused/rhythm/budget/model/harness/runner_id）+
  fleet-observer board（runners/states/turns/missions 段）+ 心跳 harness 自报。
- 短期面：cell 内 task-engine（`cron-store/jobs.json`）+ worker-pool（fd-prod cap 0 串行），
  可见性只有 cell 内 WS/REST；`dashboard_state` 的 `activeTasks` 是恒空占位（task-engine.js:500）。
- 缺口：pod 密度不在任何心跳字段；跨 cell 短期执行零可见。

## Goals / Non-Goals

**Goals**：① 甲/乙读法定案并落文档；② cell 短期执行以只读遥测进舰队面（board 统一视图）；
③ runner 心跳补密度自报；④ 姊妹仓 observer/console 收口（独立 change）。

**Non-Goals**：不做任何伸进 cell 的控制动作（pause/kill 短期任务、改 worker cap 都不做——
那是用户自己 cell 的领地）；不做短期执行宿迁移（未决 #3 定案=留在 cell）；不动 runner 侧
mission/delegation 既有事件；不建新 deployment——全部寄生既有进程（gateway/cell/runner）。

## Decisions

### D1 甲/乙读法定案：管理=甲，监控=统一只读

乙读法（全壹座统一管理面含 cell 内 worker 控制）需要 cell 自报**控制**协议——侵入面大且与
ADR-0008 冲突（cell 隔离原语=进程边界；平台伸进用户 cell 控制执行会打穿租户边界）。而定案
依据三件事：

1. **CONTEXT.md 萬星词条已写死**「对常驻与短期 agents 的**监控与管理**」——统一是义务，但
   词条没说管理动作必须直达 cell。
2. **控制动作的既有归属**：常驻 agent 的 pause/kill/budget/rhythm 全是**部署面**动作
   （registry entry + runner reconcile）；短期任务的启停/重跑是**用户面**动作（他们自己的
   TasksPage/WS）。两个归属都健康，乙要造的第三种「平台直接控制用户 cell 内执行」没有需求方。
3. **规模命题的真实痛点是看不见，不是控不动**：数百 agents 下运营者要答「多少短期执行在跑、
   排队多深、worker 池饱和没」——这是监控问题。

→ 甲为主体；「乙」降格为其只读半边：cell 遥测进统一舰队视图，无控制回程。
未决 #3 联动定案：短期执行宿留在 cell（fd-prod 串行是内存预算的诚实现状），不搬 runner。

### D2 遥测通道：gateway 代采（pull），不是 cell 自报（push）

- **代采**：gateway 已持有活 cell 清单（spawner `cells` Map）与唯一合法入站身份（cell 只绑
  loopback、信 gateway 重铸的身份头）；新增一个平台侧采样循环，逐 cell GET 其 stats 端点，
  汇成 `cell_stats` 事件投 fleet ingest。**平台凭据只留在平台进程**，cell 零新凭据、零新入站面。
- **自报（否决）**：cell 进程持 fleet token、自配上报——runner 心跳是这么做的，但 runner 是
  平台自营进程，cell 是用户租户进程；往租户进程塞 ops 凭据 + 给每个 cell 配 env，侵入面大一个
  量级，且 MC 桥（opt-in 出站）已有前例但那是用户主动开的功能。
- 隐私边界顺势收口：代采 payload 是纯计数（见 D3），prompt 永不出 cell。

### D3 stats 快照形状（cell 侧单一事实源）

```
GET /api/tasks/stats  （标准 cell 鉴权；非 loopback 豁免——/api/cron 的豁免是历史事故面）
{ jobs, executions: { running, queued }, workers: { cap, busy, idle },
  recent: { done, failed, interrupted }, agentBusy }
```

- 派生源全部现成：tasks Map + history + attachWorkerPool 的 worker Set + isBusyFn。
  `activeTasks` 占位不修（那是 UI 语义，另行课题）；stats 是新口径、纯计数。
- `recent` 取 history 近 1h 窗口终局计数（时间参数进 stats()，便于测试）。
- worker-pool 需补一个只读 `poolStats()` getter（现有面只有 WS 广播 `{persona,state}`，含
  persona——**遥测不带 persona**，人数即可）。

### D4 gateway 代采上报器（`gateway/fleet-cells.js`）

- env：`FLEET_INGEST_URL` + `FLEET_INGEST_TOKEN` + `FLEET_CELL_SAMPLE_SECS`（默认 30）。
  任一缺失=不启动（字节级零变化）。
- 每 tick：遍历 `cells.values()`，逐个 fetch `http://127.0.0.1:<port>/api/tasks/stats`
  （带 gateway 身份头，同 spawner health 的内部通道），成功者合成一条事件：
  `{id: ULID, source: "cell-sampler", agent: "cell:<userId>", kind: "cell_stats", ts, payload}`
  逐 tick 批量 POST `${FLEET_INGEST_URL}/ingest`（Bearer token；observer 既有幂等去重按 id）。
- 尽力而为：单 cell 采样失败→跳过该 cell；ingest 失败→丢弃本批（**不落盘 spool**——
  cell_stats 是周期采样不是事件流，丢一拍等于晚 30s，与 runner 的 durable spool 语义
  不同，不为它引入盘依赖）；timer unref；全程 log-only。
- 定时串行（async 循环），不并发打满 cell。

### D5 runner 心跳密度自报

`runner_stats` payload 增 `pod: config.podMode`（布尔常量，一次读入）。缺席=旧 runner，
消费侧读作 solo（降级开放）。与 harness 数组同字段同节，board 消费零改动即显示。

### D6 姊妹仓 fd-wanxing（独立 change：add-fleet-cell-views）

- observer：EVENT_KINDS 收 `cell_stats`；board 增 `cells: {<id>: {seen_at, ...最新 payload}}`
  （30 分钟窗，与 runners 段同构）+ `cells_total`；既有段零变化。
- wanxing-web console：OpsView（或等价运维视图）增短期执行区——cells 表（身份/在跑/排队/
  worker 池/最近失败）+ 汇总条，与既有 runners 表并排=「统一舰队视图」的眼见形态。
- 良机 console 用户面（FleetView）不动——那是用户自己的部署视图，短期 cell 执行不属于它。

## Risks / Trade-offs

- [代采把 cell 短期负载的可见性绑定在 gateway 存活上] → gateway 本就是 cell 的唯一入口，
  它死则整个租户面已死，遥测随之消失是诚实行为（board 窗口自动老化）。
- [cell_stats 可被伪造（ingest 是 append-only 遥测）] → 影响面=监控数字失真，无控制后果；
  ingest token 不出平台进程已是最小面。
- [stats 端点成为 cell 新出站只读面] → 标准鉴权 + 纯计数（无 prompt），泄露面≈零。
- [数百 cell × 30s 采样 = gateway 定时负载] → loopback + 串行 + 每请求轻量 JSON；tick 超时
  单独掐（fetch timeout ~2s），不与请求路径共享线程语义（Node 单进程下本就异步非阻塞）。
- [fd-wanxing 侧 EVENT_KINDS 白名单滞后于 paas 侧上报] → 上线顺序：先 observer 后 gateway
  env（未配即不上报，不存在被拒流）。

## Migration Plan

1. paas 侧实现+测试（默认全关）→ 出片（fd-build-channel 判路；一次镜像两滚动位）。
2. fd-wanxing 侧 change：observer + console → 各自发布线滚产。
3. 开门：fd-prod 配 `FLEET_INGEST_URL/TOKEN`（GitOps env）→ 观察 board cells 段填充。
4. 回滚：摘 env 即回零（上报器不启动）；observer 侧 kind 白名单多一行无害。

## Open Questions

（无——甲/乙与 #3 均已在本设计定案，board 段的 UI 排布属姊妹仓 change 内的自由度。）
