# harden-cell-wake-admission — Design

## Context

准入闸现状（harden-platform-memory-carrier 已上产）：`gateway/spawner.js` 的 `memoryAdmissionVerdict()` 在 `spawner.ensure` 唯一 spawn 门（provision 与 park-resume 同闸）前置，调 `lib/proc-memory.js` sampler 的 `admission(floor)`——判据是**当下** cgroup 余量比例（floor=0.15，env `CELL_MEMORY_ADMISSION_FLOOR` 可覆写）。拒绝证据落 `cells-registry.db` 的 `last_gate_refusal_json`；同一 sampler 实例供 `/api/monitoring/memory` 三层读面（per-cell 归组 RSS 已可读）与运维坞水位卡。生产实测（2026-11-04）：29 cell（3 running/26 suspended）、0 拒绝、唤醒 1da519d4 六次 OOMKill——诊断与数据见 proposal「Why」。

关键既有事实：

- sampler 带 TTL 缓存（读面「缓存窗口内重复读不放大扫描」requirement），per-cell RSS 归组用 /proc statm + cwd/cmdline/单步 ppid 继承，cgroup v2 优先 v1 回落。
- parked cell 的状态落盘（既有 park 原语，`CELL_IDLE_REAP_SECS=3600` 是现役 reap 阈值语义）；resume 路径是 `spawner.ensure` 的一部分。
- 「1da519d4 名义 RSS 1598MB vs cgroup 实扣 ~956MB」的差值是共享页重复计；**足迹档案必须记 cgroup 口径实扣，不能记 RSS 名义和**，否则投影永久超卖、闸变成全天候拒绝。
- OOMKill 发生在唤醒窗的**瞬时尖峰**，不是稳态：稳态 956MB，物化过程冲破 1610MB。

## Goals / Non-Goals

**Goals**

- 唤醒（park-resume）准入以「投影水位」判定：current + 被唤醒 cell 的 last-known cgroup 实扣足迹。
- 投影不足时先驱逐闲置驻留腾位，驱逐后复投影；仍不足才拒绝，拒绝发生在物化之前。
- 拒绝/驱逐证据可读、可审计，沿既有四元组扩展。
- 全链 fail-open：sampler 异常、足迹缺失、陈旧超限时回退现行行为（只看 current），绝不因投影数据质量阻塞唤醒。

**Non-Goals**

- 不改 floor 语义与缺省值；不做 limit 提限；不修两级卫星链归组；不做驻留主动换页/压缩等花活。
- 不驱逐**非闲置**驻留（`last_user_traffic_at` 在 reap 阈值内的 cell 一律不碰，活跃 cell 无感）。

## Decisions

### D1. 足迹档案：resume 时点物化，park 时点更新，记 cgroup 实扣

cell **park 完成时**把本次驻留期的 cgroup 实扣（cell 归组合计，同 sampler 口径）写入 registry（新列 `last_footprint_bytes`，guarded ALTER 先例）；resume 准入读它做投影。

- 为什么 park 时点而非常驻采样：park 时点正好是「该 cell 完整驻留」的采样窗终点，一次扫描零新增开销；运行中 cell 的实时值已由读面 TTL 缓存覆盖。
- 为什么 cgroup 实扣而非 RSS 名义：投影要预测的是 cgroup killer 的判定口径；RSS 名义和会永久超卖。
- 为什么新列而非塞 workload_json：`last_gate_refusal_json` 的 guarded ALTER 已趟过路，列级演化风险最低。
- 备选被否：唤醒时现场预测（无历史可依，等于没修）；常驻后台采样（为低频路径常开扫描，不值）。

### D2. 投影判定：provision 与 park-resume 分口径

- **provision（新 cell）**：现行为保持——只有 current 可依（无历史足迹），floor 判定不变。新 cell 无足迹档案，投影无从谈起；首驻留结束 park 时档案自然积累。
- **park-resume（唤醒）**：`projected = current + last_footprint_bytes`，`admission(floor, projected)`——floor 判据从 `current/limit` 改为 `projected/limit`，其余（阈值、fail-open）同构。
- 备选被否：给 resume 单独设更严 floor（把增量折进阈值）——数学上等价但语义混淆，拒绝证据里「阈值」不可读。

### D3. 驱逐链：投影不足 → 驱逐闲置 → 复投影 → 拒绝

```
resume(cell X, 足迹 F)
  ├─ projected = current + F ≤ (1-floor)·limit ──> 放行物化
  └─ projected 超限
      ├─ 收集驱逐候选：running 且 last_user_traffic_at 距今 > CELL_IDLE_REAP_SECS
      │   （按闲置时长降序，逐个 park——复用既有 park 原语，状态落盘）
      ├─ 每驱逐一个复投影一次，够即停（最小驱逐原则）
      ├─ 驱逐后 projected ≤ 线 ──> 放行（驱逐清单入证据）
      └─ 候选耗尽仍超限 ──> 拒绝（证据含投影值+已驱逐清单），X 保持 parked
```

- 逐个驱逐逐个复评，不一把梭全 park：最小扰动。
- 被驱逐 cell 的下一次触达走既有 resume 路径（可能触发本闸投影——递归深度天然有限，极端时拒绝，无活锁）。
- 备选被否：唤醒时同步等待驱逐后「水位实测回落」（TTL 缓存与 cgroup 回收有延迟，实测不可靠；投影公式已够判）。

### D4. fail-open 与数据质量边界

- `last_footprint_bytes` 缺失（首唤醒，park 于本 change 上产前）：回退现行「只看 current」判定，如实降级、不告警刷屏（首唤醒必然命中，属预期态）。
- sampler fail / TTL 陈旧超限（沿用读面 TTL 上限）：fail-open 放行 + console.warn，与现行闸纪律同构。
- 驱逐动作本身失败（某 cell park 异常）：跳过该候选继续，不阻塞驱逐链。

### D5. 证据扩展

`last_gate_refusal_json` 增字段：`projected_bytes`、`footprint_bytes`、`evicted_cell_ids`（本次拒绝前实际驱逐者）。既有四元组（used/limit/headroom/threshold）保留，`used` 语义在 resume 拒绝中=投影值——运维坞渲染无需结构变更，水位卡透出新增字段为渐进增强（不属本 change 验收硬项）。

## Risks / Trade-offs

- [足迹档案冷启动期（上产后第一次唤醒每个 cell）无投影，行为同旧] → 如实降级即 D4；档案随首次 park 全量积累，1 小时 reap 节奏下冷启动窗有限。
- [驱逐误伤边界：last_user_traffic_at 依赖流量打点准确] → 沿既有打点（duty run 也刷新），阈值复用 3600s 现役语义；驱逐事件全量可审计，误驱逐的 cell 触达即自动 resume（秒级恢复，状态在盘）。
- [投影低估尖峰：足迹是 park 时点稳态，唤醒物化瞬时峰可能高于档案] → 档案取 park 前**末次采样**含峰值余量（sampler TTL 窗内本就覆盖运行期波动）；floor=0.15 本身是尖峰缓冲；真低估时 fail 的代价=一次 OOMKill（同现状），不劣化。
- [驱逐链与 reaper 竞争：reaper 同时在 park 同一 cell] → 驱逐候选收集与 park 动作间用既有 inflight/状态机守卫（idempotent park），重复 park 无副作用。

## Migration Plan

1. 单测（D1–D5 全分支）→ 接线 → e2e（demo pod：park 大 cell → 压水位 → 唤醒看投影/驱逐/拒绝三路）。
2. 出片沿公开免费线（快照→relay→GitOps→ArgoCD hard 刷新，见 §15.126 配方）。
3. 上产后观察：`last_gate_refusal_json` 首批投影拒绝/驱逐事件；1da519d4 复唤醒（16 进程真足迹）不 OOM。
4. 回滚：滚回上一镜像即全量回退（新列只增不删，旧代码无视之）；驱逐语义随旧代码消失，park 状态无损。

## Open Questions

- 运维坞水位卡是否为驱逐/投影字段加显式渲染（i18n 五语）——可作为本 change 范围内顺手项或后续增强，不影响验收判据（证据 JSON 可读即可）。
- `CELL_IDLE_REAP_SECS` 未来若改语义（如分级），驱逐阈值是否跟着走——design 倾向跟（同一「闲置」定义），届时在实现里同源读取而非复制常量。
