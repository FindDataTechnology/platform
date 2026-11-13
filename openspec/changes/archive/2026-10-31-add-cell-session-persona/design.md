# Design: add-cell-session-persona

> 底稿：`docs/agent-parallel-execution-explore.md`（切片①）。桥侧 `preset/set` 的 RPC 语义
> 已由 `dsh-runtime-bridge` 既有需求钉死（parked-only、活会话显式拒绝、未知 preset 创建期
> 晚失败、capabilities 上报）——本 design 只定 **cell 宿主侧** 的接线。

## Context

定时车道 persona 回合今天靠重启换人设：`runPersonaTurn`（server/cron-runner.js:413）→
`switchPresetForJob`（:210，waitForIdle + `ctx.switchPresetTo` → `dshBridge.restart`）→
`normalizeModelForJob`（live model/set）→ prompt。重启窗由
`ctx.reserveRuntime("cron-preset-switch")` 挡 web 队列。桥已有 `#probeLiveMethods`
（platform/capabilities → `#liveMethods` 集合，dsh-bridge.js:170），`preset/set` 在
插件的 `LIVE_METHODS` 里（pod adapter 起生效），runner pod 侧的消费范式在
`agent-runner/harness/dsh.js:321`（首 prompt 前 park + `#prepared` 世代集合）。

已核实的边界：定时车道归属的 preset 输入是任务驱动（fleet-events.js:92 读
`request.targetRef.id`）；`ctx.currentPreset` 其余消费点全在聊天车道。fleet 回合的
子进程对话 id 逐回合轮换（`roundChildSessionId`），绑定会话任务复用稳定 mirror id。

## Goals / Non-Goals

- **Goal**：定时车道 persona 回合零重启换人设；运行时默认不被定时车道移动；回退显式留痕。
- **Non-Goal**：每会话模型（model 仍进程级，`normalizeModelForJob` 的强制断言与还原不变）；
  worker pool / 真并发；聊天车道 preset 选择（`switchPresetTo` 原样保留）；
  `current_preset` WS 事件语义；worker-slots 车道（pool 拒认领 persona 任务之外的行为不变）。

## Decisions

### D1 驻留状态放 dsh-bridge，按 child 世代记账

`#preparedPresets: Map<sessionId, presetId>`，`#spawn` 时清空（与 `#presetCache`
同生命周期——「fresh child = fresh roster」同款理由）。`deleteSession` 同步删条目
（fleet 回合收尾的 `disposeRoundChild` 删了会话，条目不留垃圾）。

- API：`async setPreset({ sessionId, presetId })` 透传 RPC；`supportsPresetSet()` 读
  `#liveMethods.has("preset/set")`；`preparedPreset(sessionId)` 读世代集合。
- 备选被否：把世代集合放 cron-runner（宿主侧 Map）——重启生命周期由桥内聚，宿主侧
  重建时机（意外退出自动重拉）不止一条路，放桥内才不会漂。

### D2 回合执行器双路径：park 路径 / legacy 路径

`runPersonaTurn` 的 preset 段改为选路（`job.preset` 为空 = 既有的「跑在当前 preset」
行为，两路径都不碰）：

```
awaitRuntimeReadyForJob（不变）
→ waitForIdle（两条路径都保留：不与用户流式回合交错——收尾进程级串行下，
   定时回合插进用户回合会把用户的收尾饿死，这是既有纪律不是重启的副产品）
→ 选路：
   park 路径（supportsPresetSet && 未驻留 || 已驻留同 preset）：
     不取 reserveRuntime（无重启窗）；preset/set park 到 childSessionId；
     normalizeModelForJob（不变，live）
   legacy 路径（能力缺失 / park 被拒 / park 硬错）：
     与今天逐字节等价：reserveRuntime("cron-preset-switch") → switchPresetForJob
     （waitForIdle + switchPresetTo 重启）→ normalizeModelForJob
→ prompt(childSessionId)（不变）
```

- park 调用点在 prompt 之前、collectTurn 注册之前——失败（落回退）时不得留下半注册
  的 collector。
- 回退触发三源：① `supportsPresetSet() === false`；② park 被拒（会话在当前 child 已活
  ——按 spec 用「persona is creation-time composition」的消息语义识别，该文案已被
  `dsh-runtime-bridge` 需求钉死，匹配是合同背书的不是脆弱巧合）；③ park 其他硬错
  （未知 preset 等——理论上写面已挡，防御性落回退）。
- 三源回退 SHALL 都留痕：`console.warn` + 回合执行记录 `detail.presetPath: "legacy:<reason>"`；
  park 路径记 `detail.presetPath: "parked"`。这是验收的观测面。

### D3 世代集合的判定顺序（镜像 runner pod 纪律）

prompt 前对 `(childSessionId, job.preset)`：

1. `preparedPreset(sessionId) === job.preset` → 跳过（本世代已驻留同一 preset）；
2. 未驻留 → 调 `preset/set`：成功 → 记入集合；被拒（活会话）→ **D2 回退**；
3. 驻留过**不同** preset（绑定会话中途换任务 preset，reconcile 改写后可能发生）→
   重新 park：会话活则被拒 → 回退；会话不活（重启后未 prompt 过）则新 park 生效。

### D4 集群扇出的还原段改为条件执行

`runClusterTurn` 尾部的 preset 还原（originalPreset 捕获/比较/switchPresetForJob）只在该轮
**至少一个成员走了 legacy 路径**时执行；全员 park 路径时跳过（运行时默认从未移动，
还原是 no-op 上的行为噪声）。model 还原（`switchModelTo(originalModel)`）不变——
model 仍进程级。summary 汇总回合与成员同机制（同执行器，自动继承）。

### D5 委托聚合回合去掉显式 switchPresetTo

`delegation-aggregator.js:92-96` 的「 wanted ≠ currentPreset 就切」整段删除：聚合回合
经 `engine.chainTurn` → persona 回合执行器，D2 的 park 路径已按任务 preset 驻留，
聚合器层的切换成为双重换装（重启发生在「队列化回合执行前」，竞态面上也是最脏的一处）。
聚合回合的 `initiatorPreset` 语义不变。

### D6 model 维持进程级的理由（写下来防后续误改）

model/set 带 sessionId 会**同时**翻转进程默认（platform-preset-bridge.js:308-310 注释
明文）——pod 宿主因此对每成员**双 park**。cell 本 change 不引入每会话 model：
`normalizeModelForJob` 的进程级归位 + 漂移强制断言（fix-fleet-model-drift）行为不变，
且多会话共享一个 child 的模型漂移面与今天完全一致。每会话 model 是切片⑤（carrier）
的事，届时随双 park 一起做。

### D7 部署期新旧 child 混存的正确性

滚版窗口内 child 可能是旧镜像（无 `preset/set`）——`supportsPresetSet()` 为假 → 全部
走 legacy = 与今天逐字节等价。**新宿主 + 旧 child 与 旧宿主 + 新 child 两个方向都安全**
（旧宿主根本不知道 park；新宿主探测后回退）。回滚 = 回滚镜像，无数据迁移、无 schema 变更。

## Risks / Trade-offs

- [ park 被拒的消息匹配脆弱 ] → 匹配串已被 spec 钉为合同（「creation-time composition」）；
  匹配失败落 D2③ 回退（宁回退不误判），warn 留痕暴露漂移。
- [ 世代集合与 child 内部状态分歧（桥外有人 prompt 过该会话）] → 分歧的表现就是 park
  被拒 → 回退，自愈；引擎串行链保证定时车道自身不会自竞。
- [ waitForIdle 保留使 park 路径仍排队在用户流式回合后 ] → 有意保留（D2）：本 change
  只摘重启税，不改变「定时回合不与用户对话交错」的纪律；真并发是后续切片的事。
- [ 回归面：cron/cluster/delegation 三条车道共用执行器 ] → 双路径全走既有单测矩阵 +
  新增驻留分支用例（fake bridge 记 park 调用序列）；legacy 路径要求逐字节等价，
  用现有测试不动即证。

## Migration Plan

1. 合入后随班出片；生产滚版后首轮定时回合观察 `detail.presetPath` 分布
   （预期全 parked；旧 child 窗口内出现 legacy 属预期）。
2. 验收判据（真机）：六人队一轮 spawn 日志零重启、运行时默认前后不变、
   用户对话在轮间不被 `waitForIdle` 之外的任何窗挡住（该窗本身保留）。
3. 回滚：镜像回滚即回退（D7 双向安全），无数据清理。

## Open Questions

- 无阻塞项。底稿 U4（`current_preset` UI 口径迁移）不在本 change 范围（聊天车道零变化）。
