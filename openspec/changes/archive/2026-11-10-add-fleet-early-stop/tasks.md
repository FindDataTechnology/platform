# Tasks — add-fleet-early-stop

## 1. 策略

- [x] 1.1 collector 在 `compaction/start` 达阈值（6）且已运行 ≥60s 时原生取消并结算为压力（`earlyStop: true`）
- [x] 1.2 仅舰队回合（`sourceTag.fleetId` 决定 `earlyStop`）；人类/普通定时不受影响
- [x] 1.3 `FLEET_EARLY_STOP=0` 开关；`earlyStopAfterMs` 可注入（测试用，不改变默认 60s）

## 2. 测试（12 条，含新增 3 条）

- [x] 2.1 达标即取消、结算带 `contextPressure`/`compactions`/`earlyStop`、并调用了一次 `cancelSession`
- [x] 2.2 无 `earlyStop` 标记时不取消（8 次压缩仍按完整预算）
- [x] 2.3 `FLEET_EARLY_STOP=0` 关闭策略
- [x] 2.4 反证：阈值改到 9999 不触发 → 该用例超时红；还原 12/12 绿
- [x] 2.5 28 个 cron-runner 消费套件全绿

## 3. 规格

- [x] 3.1 `cron-module`：回合预算条款 + 3 场景

## 4. 上线

- [x] 4.1 快照 → GHA → relay → digest → GitOps → ArgoCD → 舱内实测（2026-11-10 `sha-ffc8186`，见 6.4）
- [ ] 4.2 归档（`openspec validate --strict` 通过后）

## 5. 上产后发现的缺陷：闸门被「开场压缩风暴」绕过（2026-11-09，已修 `1726c40ff`）

> 这一节是 4.1 之后的实测回归：策略写对了，闸门的位置错了。

- [x] 5.1 归因 — 判定只在 `compaction/start` 事件里做，且要求「计数达阈值」与
  「已跑够 `earlyStopAfterMs`(60s)」在**同一事件**上同时成立。于是最常见的形状
  ——**前 60 秒内连压 4 次、之后再没有压缩事件**——永远判不中：4 次判定时 elapsed
  都 <60s，之后再无事件可判，回合一路跑满 600s 预算，占着 cell 唯一的串行槽。
  - 证据（4 个在用 cell、4493 行 history、2026-10-23→11-09）：
    `turn stopped early` **3 行** vs `turn timed out — context pressure` **48 行**；
    44 次超时的压缩数已过阈值（其中 8 次恰好 n=4）；
    `job_1794128300056_hwmvbw` **同时出现在两张单子上**——差别不在任务、也不在
    舰队标记（44 次里 43 次是舰队岗位回合、`carrier` 为空即主槽），而在压缩是否
    恰好跨过时间下限。
  - 时间线：3 次真早停全部落在 04:46–05:10 且都是 n=6（当时阈值仍是 6）；
    阈值降到 4 之后仍有 8 次 n≥4 的超时——与阈值无关，是判定时机的问题。
- [x] 5.2 修法 — 闸门收成唯一入口 `maybeEarlyStop()`；计数达阈值但未到时间下限时，
  挂一次性定时器在下限到点复判（`settle` 时清除、`unref` 不吊住进程）。
  策略本身一字未改：同阈值、同下限、仅舰队回合、同样以压力口径收口并走收尾补数。
- [x] 5.3 测试 — `test-fleet-context-pressure` 14 条（新增 2 条：风暴后静默在下限处
  停；未达阈值仍跑满预算）。**旧 4 条全部注入 `earlyStopAfterMs: 0`，这正是这个缺陷
  从未在 CI 见红的原因**——测试把被测策略的前提给抹掉了。
  变异检查：还原旧闸门 → 新用例 2 秒内转红。相邻套件全绿：fleet-turn-events 15 /
  worker-pool 16 / queue-health 12 / cron-catchup 11 / history-kinds 9。biome 干净。
- [x] 5.4 上产验证（随 4.1 一起）— 镜像更新后 24h 内应看到：
  `turn stopped early` 显著上升、`turn timed out — context pressure` 中 n≥4 的降到 0。
  复算用 `paas/scripts/queue-history-stats.mjs --hours 24 --json`（唯一读面，别再自己写 `cls()`）。
  → **已达（窗口 1h+，非满 24h；数据=4 个在用 cell 的 `cron-store/jobs.json`，2026-11-09T17:0xZ）**
  - 三次分批上产正好构成对照，把每处修复的贡献**单独隔离**了：
    | 镜像基线 | 在产修复 | 结果 |
    |---|---|---|
    | `113233eb8` / `108e694b2` | 早停未接 worker 车道 | 14:18–15:19 **7 条**压力超时，**全部烧满** 600–613s |
    | `108e694b2` 仅主链闸门 | 闸门在，worker 不传 `earlyStop` | 15:40:49 仍 **n=7 烧满 612s**（worker 回合，闸门没参与） |
    | `fd23f9ceb` 及以后 | 闸门 + worker 接线 + sweep/认领 | **16:14 起 3 条早停、0 条压力超时** |
  - 早停实测：`15:40:40 n=4 533s`（主链首例）、`16:14:59 n=4 333s`、`16:16:27 n=4 313s`、`16:26:39 n=4 298s`。
  - **`n≥4` 的压力超时自 15:40:49 起为 0** —— 达标。
  - 两个限定（不写清会高估）：① 298–333s **不是**闸门迟钝：`earlyStopAfterMs` 产线无人覆盖
    （只有 `worker-slots.js:221` 透传、无 setter），下限就是 60s 常量；慢是因为 4 次压缩本身发生在
    回合后期（按每次 15–49s 实测间距，第 4 次落在 260–400s 很正常），闸门"一到位就停"。
    这条**未能直接测**：cell `trace.db` 近 1h 仅 14 条事件、15:30 后 `compaction` 0 条（采样极稀），属推断。
    ② 仍有 `n=2` 的压力超时（14:18 / 15:18，607–612s）：压缩数低于阈值，早停按设计不适用——
    那是**慢回合**不是压缩风暴，不算进本修复的账。


## 6. 上产后发现的第二处缺陷：worker 车道的接线被同仓重构整段删掉（2026-11-10）

> 5.x 修的是「闸门位置」。这一节是另一回事：闸门本身在，但**池车道的入口把参数丢了**。

- [x] 6.1 归因 — `fix-…` 曾把 `collectTurn(..., { earlyStop })` 接进 worker 车道；
  随后 `1c003d38b`（orphan sweep 改写 dispatch 段）重写同一调用点时，把整个
  **可选参数对象连注释一起**删除。可选参数 ⇒ 编译通过、类型无涉、19 条既有用例
  全绿，**没有任何信号**。产线 `TASK_WORKER_MAX=3`，于是池车道跑满 600s、链道照停。
  - 线上取证：`sha-0b19a2e` 容器内 `grep -c "earlyStop: Boolean(fleetTagOf(task))"`
    = **0**（同镜像 `spill-policy`=4、阈值 4 都在，排除「镜像不对」）。
  - 基线（近 12h，按小时对账）：`turn stopped early` **6** 次 vs
    `turn timed out — context pressure` **25** 次（其中 n≥4 **20** 次）。
- [x] 6.2 修法 — 恢复那 4 行；`earlyStopAfterMs` 保留可注入。
- [x] 6.3 测试 — `test-worker-pool` 新增**源码级接线断言**（调用点必须把 `earlyStop`
  交给 `collectTurn`）；行为级用例依赖事件泵时序，天然 flaky，故守接线事实。
  反证：删掉该行 → 1 红；恢复 → 20/20 绿（快照树内同验）。
- [x] 6.4 部署 — `sha-ffc8186`（源 `fd23f9ceb`），was **superset** of 前一片
  `sha-7a73257`（同基线 `f5cd5ebfc`，树内 `interrupted` 结算与 `earlyStop` 同时在）。
  走正常 GitOps（ArgoCD 于 16:03Z 恢复首同步）+ digest 闸 `sha256:a412af86`
  （hkccr 与 ccr 同 digest）。舱内实测 `earlyStop=1`、`spill-policy=4`、阈值 4、20/20 绿。
- [x] 6.5 上产验证 — 与 5.4 同一窗口；修复后 24h 内应看到 n≥4 的压力超时趋零。
  → **已达**：接线进产后（`fd23f9ceb` 起）16:14–16:26 出现 3 条 `turn stopped early (n=4)`，
  而 **15:40:49 之后再无一条 n≥4 的压力超时**。窗口 1h+，未满 24h，故按"方向达成、样本仍短"记。
  **回滚注意**：`sha-7a73257` 及更早的片**不含**本接线，回滚会把缺陷装回去。

## 7. 上产后发现的第三处缺陷：早停的取消打错了 bridge（2026-11-10，`sha-3db84d7`）

> 6.x 修的是「接线在不在」。这一节是「接线在、但指向错的对象」。

- [x] 7.1 归因 — 早停里写死 `ctx.dshBridge?.cancelSession(sessionId)`。串行链对，worker 错：
  会话活在**每个 worker 自己的子进程**里，发给主 bridge 的 `session/cancel` 是 no-op。
  于是 collector 立刻按早停收口、槽释放（`prompt()` 只返回入队消息 id、不等回合结束），
  但子进程继续跑完那一轮、继续烧预算，台账却记 `stopped early`——「修复看起来生效、代价照付」。
- [x] 7.2 修法 — `collectTurn` 增加可注入 `cancelSession`（缺省仍是 `ctx.dshBridge`，
  串行链行为逐字节不变）；worker 车道传 `worker.bridge.cancelSession`。
- [x] 7.3 测试 — `test-worker-pool` 新增确定性风暴用例（阈值即停 / 取消落在 worker bridge /
  结算 failed 且文案 stopped early）。下限注入为 0 去掉时序成分；pod 内曾 1/8 假红
  （固定等两拍不够），改轮询状态后本地 12/12、pod 内 10/10。反证两处：去掉
  `cancelSession` → 取消打主 bridge 即红；去掉 `earlyStop` → 用例挂住。
- [x] 7.4 观测缺陷 — worker 的失败结算不带 metering，`carrier` 为 NULL（与「未知」不可区分）；
  `settle` 统一盖 `carrier=worker` + `carrierInstance`。反证：去掉即红。
- [x] 7.5 上产实测（`sha-3db84d7`，17Z 复核）— 05–15Z：早停 1（链道）、压力超时 19、其中 n≥4 **14**；
  16Z 起：早停 **3**（324s/313s/298s，均 n=4，`carrier=null` 指纹 + spawn 日志判定为 worker 车道）、
  **压力超时 0**、n≥4 **0**。
  探针口径更正：早停文案本身含 `context pressure (N compactions)`，第一版正则把它同时计入超时桶
  （报成 25/20，真值 19/14）。
