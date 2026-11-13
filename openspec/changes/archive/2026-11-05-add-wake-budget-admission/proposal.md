# Proposal: add-wake-budget-admission

## Why

滚版后的集中唤醒窗是生产已两次实锤的 OOM 形态（2026-11-04 23:05–23:24 五连 OOMKill 后第 5 容器收敛；先例 §15.126 启动窗 OOM）。根因在代码层已定谳：唤醒准入是**逐个独立判定**——`proc-memory` 采样器带 2s TTL 缓存（`lib/proc-memory.js:257`），同一 TTL 窗内的 N 个并发唤醒全部读到同一份「彼此都还没起」的当下水位，各自投影、各自放行（TOCTOU），物化后实扣冲破 cgroup limit；且被硬杀（OOMKill）的 cell 没有 exit handler 落档，足迹缺失降级 current-only，风暴自我延续。harden-cell-wake-admission 的投影闸与驱逐链解决了「单次唤醒看不见自己增量」的问题，没有解决「多个唤醒互相看不见」的问题。

## What Changes

- gateway spawner 引入**在途唤醒预约账本**：`ensure()` 在准入判定前登记本唤醒的占用字节（在途集合 Σ），判定式从「current + 我的足迹」升级为「current + Σ在途预约 + 我的足迹」；判定结束（放行/拒绝/失败）在 finally 释放预约。
- **保守默认足迹**：无足迹档案的唤醒不再以零增量参与记账，改按 env `CELL_WAKE_DEFAULT_FOOTPRINT_MB`（缺省保守值）计入；首次 graceful park 落档后自动回归真实档案——per-cell 窗口，无需 pod 级 boot 计时器。
- 驱逐链复投影语义不变，但复投影时**其他唤醒的在途预约照记**；fail-open 纪律不变（采样故障放行并告警，预约同步释放）。
- 拒绝/驱逐证据沿 `last_gate_refusal_json` 扩展：携带预约合计与是否适用默认足迹，便于事后对账滚版窗。
- 非目标：不改 park/wake 生命周期原语；不建 pod 级 boot 计时器/漏桶限速；不引入第二调度器；不滚版 drain 自动化（纪律面另议）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `platform-memory-observability`: 「内存准入闸与 fail-open」requirement 修改——唤醒准入判定式加入在途唤醒预约合计；无足迹档案的唤醒按保守默认足迹参与记账（替代零增量降级），首次 graceful park 落档后回归档案值；fail-open、驱逐链（活跃不逐、闲置降序、逐个复投影）、拒绝于物化之前等既有纪律全部保留。

## Impact

- 代码：`paas/gateway/spawner.js`（ensure/evictUntilAdmissible/recordGateRefusal）、`paas/lib/proc-memory.js`（admission 纯函数新增 inflightBytes 入参）。
- 测试：`paas/scripts/test-cell-wake-admission.mjs` 扩展并发记账段（harness 骨架不动）。
- 配置：新增 env `CELL_WAKE_DEFAULT_FOOTPRINT_MB`（缺省保守值，未设时按内置缺省走，闸仍可整体关闭）。
- API：`memory_floor` 错误的 `err.memory` 可选新增字段（预约合计/默认足迹标记），消费方为运维读面，向后兼容。
- 部署：随下次 gateway 滚版生效（GitOps 通道）；本 change 即在收窄同一滚版窗的风险面。
