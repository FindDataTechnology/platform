# 萬星/壹座侧需求：Agent 集群的多模式编排（fleet-orchestration-modes）

> 来源：柏讯内容舰队（`fd-wire` change `wire-content-fleet`）实施与评审中发现
> 对象：paas（壹座 + 萬星）仓
> 状态：**架构级提案，待评审**。与 `wire-content-fleet-requirements.md`、`fleet-post-model-requirements.md` 独立。
> 定位：不是「给舰队补一个工具」，是把**一次回合的契约**从隐式变显式，让编排模式成为它的取值组合。

## 一、结论先行

当前舰队只支持**一种**编排模式：cron 触发 × 报数上行 × 组织树。其余五种常见范式（主管派活、流水线、事件驱动、共享态、辩论裁决）都无法表达，且**不是缺功能，是缺抽象**——触发源、结果去向、拓扑三件事被焊死在两处实现里（`reconcile` 与 `runPersonaTurn`）。

建议按顺序做三件事：①回合失败成为一等事件 → ②抽出 `turnRequest` 原语（source / resultSink / depth）→ ③模式成为舰队级声明。**不新建调度器，不加第二套执行路径。**

## 二、现状核查（已实读代码）

| 事实 | 证据 |
|---|---|
| 舰队层不拥有调度器；节奏物化为任务引擎的 cron 任务 | `server/fleet-reconcile.js` 头注释；`agent-fleet-core` spec |
| 成员回合只暴露两个工具：`report_status` / `escalate` | `server/fleet-mcp.js` `TOOLS` 数组 |
| 被动岗只能被 cron 或「拍板批复后的 execute-now」唤醒 | `agent-fleet-core` spec；`routes/fleets.js:697-725` |
| 上级读下级报数靠 `{{fleetContext}}` 注入，**只注入直接下级给上级** | `server/fleet-context.js`；`routes/fleets.js:684` |
| 回合失败返回 `{ok:false,error}`，只留在会话/结果对象里 | `server/cron-runner.js:164/182/216/222/273/289` |
| 任务引擎无连续失败计数、无失败事件 | 全仓 grep 无 `consecutive`/`failCount` |
| cluster 扇出支持 `first` 与汇总两种聚合，成员状态逐条记录 | `server/cron-runner.js:348-365,443-465` |

**关键结论**：执行原语（`runJobNow` + `runPersonaTurn`）本身够用；缺的是「谁发起、结果给谁」这两件事没有表达位。

## 三、模式矩阵：六种范式，支持一种

| 范式 | 触发源 | 结果去向 | 现状 |
|---|---|---|---|
| 定时组织树 | cron | 报数上行 | ✅ 唯一实现 |
| 主管派活（supervisor） | 主管回合内发起 | 回调用者 | ❌ 无派发、无回传 |
| 流水线（DAG） | 上游完成 | 下一节点 | ❌ 无依赖表达 |
| 事件驱动 | 外部事件 | 订阅者 | ❌ 无事件源 |
| 共享态（黑板） | 任意 | 写共享区 | ❌ 无共享载体 |
| 辩论/集成 | 并行扇出 | 裁决者汇总 | ⚠️ cluster 有扇出与两种聚合，但不是「多轮互驳 + 裁决」 |

## 四、根因：三件事焊在一起

```
        触发源 (cron | 人工 | 同伴 | 事件)
            ×
        结果去向 (报数 | 回调用者 | 写共享区)
            ×
        拓扑 (树 | 图 | 全连接)

现状 = cron × 报数 × 树，且树只有上行边
```

任何新模式都要动这三条里至少一条，而它们目前没有独立抽象：
- `reconcileFleet` 直接把 `cadenceSpec` 物化成 cron 任务（触发源写死）
- `runPersonaTurn` 写死「跑完写会话 + 可选报数」（结果去向写死）
- `parentRef` 只用于 `{{fleetContext}}` 的注入路径（拓扑只被用作展示与注入）

## 五、需求

### O1 · 回合失败 SHALL 成为一等事件（前置，独立价值）

每次成员回合结束 SHALL 产生一条可查询的结果事件，至少含：`fleetId`、`memberId`、`source`（触发源）、`status`（ok/failed/interrupted）、`errorKind`（分类）、`model`、`startedAt/endedAt`、`sessionId`。

- 失败 SHALL 在驾驶舱可见（岗位卡状态 + 失败原因），SHALL NOT 只留在会话文本里；
- 同一岗位连续失败次数 SHALL 可读（不要求落独立计数表，可从事件流聚合）；
- `errorKind` SHALL 区分：模型/上游、工具/权限、运行时未就绪、超时、业务拒绝。

**为什么前置**：任何新编排模式都要回答「失败告诉谁」。现在连定时模式都没回答。

**验收**：构造一次失败回合，驾驶舱能看到该岗位失败状态与原因；连续 3 次失败后该岗位卡片呈现「连续失败」。

### O2 · 抽出 `turnRequest` 原语

系统 SHALL 以一个显式契约描述「一次回合」，取代当前散落在 `runJobNow` / `createManualTask` / 决策送达三处的隐式形态：

```
turnRequest = {
  source:     "cron" | "manual" | "peer" | "event",   // 谁发起
  targetRef:  { kind, id },                            // 岗位 / persona / cluster / a2a
  brief:      string,                                  // 自包含任务说明
  evidence?:  [{ ref, asOf }],                         // 触发依据，可解析
  resultSink: "report" | "caller" | "blackboard",      // 结果给谁
  depth:      number,                                  // 0 = 外部发起；派发 +1
  budget?:    { minutes }                              // 可选，缺省继承目标岗
}
```

- 现有三种形态 SHALL 都能表达为 `turnRequest` 的实例（cron → `source=cron, resultSink=report`；决策送达 → `source=manual`；集群扇出 → 多次 `source=cron` 的并行）。
- `depth` SHALL 有上限（建议 1），超限结构化拒绝——防链式放大。
- 回合执行 SHALL 保持现状：preset 归位、模型归位、身份注入、报数通道全部照常。

**验收**：现有全部回合路径经新原语表达后，行为与现状逐字节一致（这是回归门槛，不是新功能）。

### O3 · 横向派发：`source=peer` + `resultSink=caller`

成员回合 SHALL 获得 `dispatch` 工具：唤醒**同舰队**的另一岗位，`depth` 递增，结果回传给调用者（回传内容为目标的回合摘要 + 产出引用）。

- 仅同 `fleetId`；不得自派；`depth ≥ 1` 时不可再派发；
- 每岗位每回合派发次数上限 + 舰队级每小时上限；
- 目标为 a2a 时走既有委托通道，不新开路径；
- 派发与被派发双方 SHALL 各产生一条 O1 事件。

**验收**：主管岗派发执行岗 → 执行岗起回合且 prompt 含派发者身份与 brief → 结果回传主管岗下一回合；自派/跨舰队/超深度/超频次均被结构化拒绝。

### O4 · 舰队级模式声明（只声明默认与允许的边）

舰队 SHALL 支持 `mode` 声明，决定：默认 `source`、默认 `resultSink`、允许的边集合。

| mode | 默认 source | 默认 resultSink | 允许派发 |
|---|---|---|---|
| `schedule`（默认，= 现状） | cron | report | 否 |
| `supervisor` | manual/peer | caller | 是（depth ≤1） |
| `pipeline` | peer | caller | 是（沿依赖边，depth ≤节点数） |

- 未声明 SHALL 等价于 `schedule`，行为逐字节不变；
- `pipeline` 的依赖边 SHALL 显式声明（不允许隐式按建队顺序推断）；
- 模式 SHALL NOT 引入第二套调度器：所有回合仍走任务引擎。

**验收**：同一批岗位在 `schedule` 与 `supervisor` 两种 mode 下，触发方式与结果去向按表生效，且 `schedule` 与现状一致。

### O5 · 黑板（可选，后置）

若需要「多岗共享中间产物」，SHALL 以舰队级只读/可写命名槽位实现，SHALL NOT 引入消息总线。此项不阻塞 O1–O4。

## 六、明确不做

- **不做 agent 自由对话 / 全连接拓扑**：边必须显式、有界、可审计；
- **不做共享消息总线 / 事件流平台**：`source=event` 只接**已有**信号源（覆盖缺口、质量快照、需求单、告警），不新建总线；
- **不做多跳编排 A→B→C**（depth > 1），除非有明确的成本与失败归属方案；
- **不改任务引擎的调度语义**，也不引入第二个调度器；
- **不做自动重试/自动降级**（失败先可见，再谈自动处置）。

## 七、实施顺序与依赖

```
O1 失败事件  ──┬──> O2 turnRequest 原语 ──┬──> O3 横向派发
（独立价值）    │                          └──> O4 模式声明
                └──> （驾驶舱失败可见，可与 O2 并行）
O5 黑板 = 后置，不阻塞
```

- O1 可以单独上线，即使不推进任何模式也有价值；
- O2 是纯重构，验收标准是「行为不变」；
- O3/O4 才引入新能力。

## 八、与柏讯内容舰队的关系

柏讯的 3 岗舰队（巡线/内容/源）按现状**只能跑定时组织树模式**：巡线岗到点巡视，内容岗永远等不到活。要让它成为真正的流水线，需要 O1 + O2 + O3 + O4（`mode: supervisor`）。

在 O3 落地前，柏讯侧的替代做法是给内容岗也配节奏（变成定时轮询），代价是空转与成本。**本提案落地后，柏讯侧只改模板的 `mode` 声明，不改代码。**

## 九、参考落点

```
server/fleet-reconcile.js        节奏物化（触发源写死处）
server/cron-runner.js:220        runPersonaTurn（结果去向写死处）
server/cron-runner.js:430-470    回合结果记录（O1 的现成挂点）
server/fleet-mcp.js              TOOLS（O3 新工具的挂点）
server/routes/fleets.js          member 写面（O4 mode 字段）
server/fleet-context.js          {{fleetContext}}（拓扑唯一的运行期用途）
```
