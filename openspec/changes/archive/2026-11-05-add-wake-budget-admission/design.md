# Design: add-wake-budget-admission

> 探索出处：2026-11-05 explore 会话（唤醒风暴 × 运行管理层合流探索）。机制事实、量化账与 P2 重审注记均以盘上代码为准。

## 背景：闸的现有形态（代码事实）

- `lib/proc-memory.js`：StatefulSampler 每 TTL 窗（2000ms）做一次 /proc+cgroup 扫描，`admission(threshold, { projectedBytes })` 是纯函数——projectedBytes（被唤醒 cell 的校准足迹）直接计入判定。
- `gateway/spawner.js`：`ensure()` 是所有驻留（spawn-on-traffic 与 park-resume）的唯一咽喉；per-user inflight promise 只折叠同用户并发。准入判定在 `memoryAdmissionVerdict(wakeFootprint)`；拒绝且有足迹时走 `evictUntilAdmissible`（闲置降序逐个 park、逐个 `clearCache()` 强制新鲜采样再投影）。
- 足迹档案：`stop()`（graceful park）时 `archiveFootprint`——per-cell RSS 分组合计 × pod 级 RSS→cgroup 校准比，落 `lastFootprintBytes`。硬杀（OOMKill）无 exit handler → 无档案。

## 问题：两个看不见

1. **并发唤醒互相看不见**：2s TTL 内的 N 个并发唤醒各自读同一份缓存快照，判定式只含「current + 自己的足迹」，彼此的增量不在式内。11-04 风暴的量化账：容器 2048MB、floor 15%（准入线 ≈1740MB）、稳态 ≈956MB、大 cell 校准足迹 ≈650MB——两个大 cell 同窗醒来，各自判 956+650=1606MB（放行），实扣 956+650+650≈2.26GB > limit → OOMKill。
2. **无档案唤醒以零增量参与**：硬杀 cell 复醒降级 current-only，自身贡献完全不在式内 → 风暴自我延续（OOMKill 受害者下次唤醒继续裸奔）。

## 方案

### 1. 在途唤醒预约账本（spawner.js）

模块级 `inflightWakes = Map<cellId, bytes>`：

- `ensure()` 在发起准入判定**之前**登记 `mine = wakeFootprint ?? DEFAULT_FOOTPRINT`；`finally`（与既有 `inflight.delete(userId)` 同处）释放。
- 判定式升级：`memoryAdmissionVerdict(mine)` 内部把 `projectedBytes` 改为 `current + Σ(inflightWakes.values()) + mine`——即把「其他人的预约」与「自己的贡献」都计入投影。实现上不必改 admission 签名语义：调用方把 Σothers 并进 current 侧或新增 `inflightBytes` 入参均可，纯函数保持纯（设计取后者，测试可直喂）。
- 失败路径（spawn 抛错、判定异常）与 fail-open 路径一律走同一 finally 释放——预约不留残留。
- `evictUntilAdmissible` 的循环复投影读同一账本（其他唤醒的预约照记），驱逐自己名下预约不重复计。

### 2. 保守默认足迹（无档案窗，per-cell）

- `CELL_WAKE_DEFAULT_FOOTPRINT_MB`，内置缺省 **512**（2026-11-05 生产复核定值：cells-registry.db 29 cells，已归档足迹 808/769MB 两笔皆 cron 大户、24 个挂起 cell 无档案；按容器 2048MB/线 1740MB/稳态 956MB 算账，256MB 挡不住三连并发重尾，512MB 保住最坏情形且误拒一次唤醒即自愈）。显式置 0 = 禁用默认足迹，无档案唤醒回归现行 current-only 判定（逃生门）。
- 语义：默认足迹只参与**记账**（投影与预约），不落 `lastFootprintBytes`——首次 graceful park 落档后自然接管，per-cell 窗口自动收窄，无需 pod 级 boot 计时器。
- 闸关闭（`CELL_MEMORY_ADMISSION_FLOOR` 未设或 ≤0）时账本整体 inert：零登记零释放开销，逐字节等价现行为。

### 3. 证据扩展

`recordGateRefusal` 与 `err.memory` 增加可选字段：`inflightBytes`（判定时他人在途预约合计）、`defaultFootprintApplied`（布尔）。运维读面与 `last_gate_refusal_json` 自然透传，消费方按可选字段处理（向后兼容）。

## 兼容与风险

- **行为面**：单唤醒（无并发）+ 有档案 → 判定式与现状完全一致（Σothers=0、mine=footprint）。行为差异只出现在「并发」与「无档案」两个此前裸奔的形态——正是要修的。
- **驱逐链活锁**：并发风暴下多唤醒互相触发驱逐——驱逐候选是闲置驻留，逐个驱逐后复投影含全部在途预约，收敛性优于现状（现状是物化后互相冲爆）。拒绝路径兜底：候选耗尽即拒，friendly 文案复用 `memory_floor`。
- **TTL 缓存语义不变**：预约账本是判定式输入，不动采样器缓存纪律（`clearCache` 时机照旧）。
- **计量抖动**：预约以「贡献估计」入账，不承诺精确——保守默认值宁可高估。校准比语义照旧（park 时点档案）。

## P2 重审注记（本 change 不实施，留档防再探索）

运行管理层探索（2026-11-05，与本 change 同源）的后续方向，均已代码级核实：

1. **runner 侧 parked-apply 已实现**：`agent-runner/manager.js reconcile()` identity pass 对描述符变更 `drainAndStop` 后**下次 touch 才 spawn 新组合**——回合边界生效语义已在，勿再立「parked-apply 缺口」类 change。
2. **pod 爆炸半径是真实的密度放大器**：pod 内任一成员 identity 变更 drain 整个 pod（`manager.js:405` 注释自称「the accepted pod trade」）。数百 agents 规模下这是 churn 平方项，值得重审。
3. **`effective_model` 走 drain 是 ADR-0019 决策而非能力缺口**：adapter 已声明 `liveModel: true, perSessionPreset: true`，且 pod 成员会话首用时已在活进程内热设 `preset/set` + `model/set`（`harness/dsh.js:317-320`）——会话边界热切模型的机制现成。后续可立 change：把 model 从 `#identityOf` 摘出、改走停车图更新（新会话新模型、在途会话不变），组合级 11 字段维持 drain。
4. **`@deepseek-ai/dsh-api-session-controller@0.2.0-rc.2` 已 vendor 但未挂 bundle**：与重启税无关（runner↔child 有自己的 SDK 桥）；仅在需要 facade 直达会话面（访客 queue/steering 类）时才接线。
