# harden-cell-wake-admission

## Why

驻留内存准入闸（harden-platform-memory-carrier，2026-11-02 上产）上线至今 **0 次拒绝**，但唤醒 parked 大 cell 1da519d4 连撞 **6 次 OOMKill**（2026-11-04 走查实录，§15.125/131）。取证结论：闸量的是「当下水位」，OOM 出在「唤醒增量」——唤醒前稳态水位 956/1610MB（余量 40%，远高于 floor 15%），闸如实放行；唤醒窗进程物化尖峰（dsh 259MB + server 266MB + 14 卫星 ≈900MB 名义）瞬时冲破 1536Mi 容器限，cgroup killer 挑中唤醒窗进程。生产在册 29 cell 中 26 个 suspended，唤醒尖峰库存只增不减，节点 cheap-4 共 4GB（platform requests 已占 55%），靠提限无天花板可依。

## What Changes

- **唤醒投影准入**：park-resume 准入判定从「current 余量」改为「current + 被唤醒 cell 的 last-known 足迹」投影后再评 floor；投影不足时拒绝发生在物化之前（不再产生唤醒窗尖峰）。
- **空闲驻留驱逐链**：投影不足时，先驱逐 `last_user_traffic_at` 超过 reap 阈值（沿 CELL_IDLE_REAP_SECS=3600 语义）的空闲驻留 cell（复用既有 park 原语，状态落盘不丢失）→ 复投影 → 仍不足才拒绝。现行 spec 的「已驻留 cell MUST NOT 被本闸驱逐」条款被本刀有意改写：驱逐只落闲置驻留、只发生在有唤醒需求时、驱逐事件可读。
- **证据面同步**：拒绝/驱逐证据沿既有 `last_gate_refusal_json` 四元组扩展（含投影值、驱逐清单），运维坞水位卡可读。
- **fail-open 纪律不变**：sampler 缺失/读值异常/TTL 陈旧超限时一律放行并告警，floor=0.15 语义不变。
- Non-Goals：不做 memory limit 提限（那是 GitOps 一行事，不属行为 change）；不修两级卫星链归组缺口（dsh→mcp→sub-mcp 第二跳落 ungrouped，另行立案）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `platform-memory-observability`: 「内存准入闸与 fail-open」requirement 改写——park-resume 准入引入唤醒足迹投影；新增驱逐链行为（闲置驻留在投影不足时先驱逐后复评）；「已驻留 MUST NOT 驱逐」收窄为「非闲置驻留 MUST NOT 驱逐」。三层读面、运维坞渲染、计量零侵入等其余 requirement 不动。

## Impact

- 代码：`gateway/spawner.js`（准入判定 `memoryAdmissionVerdict` + resume 路径）、`gateway/cell-registry.js` / `lib/cell-registry.js`（足迹读取、驱逐事件、证据扩展）、`gateway/index.js`（接线参数）。
- 行为影响面：唤醒 parked cell 的路径（对话触达、duty run、走查唤醒）；被驱逐的必须是闲置超阈驻留，活跃 cell 无感。
- 数据：`cells-registry.db` 复用既有列与 park 原语，无 schema 变更（驱逐事件进既有审计通道）。
- 验收锚点：生产 1da519d4（16 进程 ≈900MB 名义足迹）唤醒不再触发 OOMKill；投影/驱逐/拒绝三路证据入册。
