# add-sub2api-fork-concurrency Proposal

## 背景
sub2api 网关（词元站）当前对上游账号的并发管理是**无界排队**：上游 5xx/限流时请求在进程内排队堆积，
故障窗口内排队时长吞噬客户端超时（坏仓库 403 拖死 relay 锁的同族病），且无自适应背压。
2026-10-27 词元配额事故与 relay 锁拖死事故的代码级根因都在此。

前置裁决（用户 2026-11-04 授权代拍）：**fork 源码归属=本仓维护**（sub2api fork patches 已建制
docs/sub2api-fork-patches/，merge-window-runbook 在册）——归属问题关闭，代码级改造可行。

## 方案（两刀）
1. **有界排队 + 快速拒**：
   - 每上游账号一个有界信号量（默认 max 8，可配）
   - 队列深度上限（默认 32）：满即 `429 queue_full` 快速拒（Retry-After 头），客户端可控重试
   - 拒绝率入 metrics，SLO 面可见
2. **AIMD 自适应并发**：
   - Additive-Increase Multiplicative-Decrease：成功→并发 +1（至 max）；5xx/超时→并发减半
   - 熔断联动既有 lane 键控熔断（fleet-turn-attribution 同族语义）：连续 N 次上游失败→open 窗口
   - 半开探测：窗口过半放一个探测请求，成功则恢复

## 范围
- 上游 fork：sub2api Go 侧 per-account concurrency limiter + queue bound + AIMD 状态机
- 补丁建制：docs/sub2api-fork-patches/ 新增 patch 文档 + upstream-pr-candidates 登记
- 观测：queue_depth/queue_rejected/aimd_state 三个 metrics
- 回归：既有 lane 测试全绿 + 新增 AIMD 状态机单测

## 验收
- 单测：AIMD 状态机全转移（success/5xx/timeout/open/half-open/recover）
- 压测：上游 5xx 注入下 queue 不无界增长、客户端 100% 得到快速响应（无吞超时）
- 生产：滚后七日 queue_rejected 率 < 1%、零 relay 锁拖死复发
