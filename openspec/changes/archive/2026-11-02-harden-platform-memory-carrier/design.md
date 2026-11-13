## Context

- 生产实拍（2026-11-02，/proc 扫描，台账 §15.124 补记）：platform pod 26 进程 RSS 总和 2261MB vs limit 1536Mi。两个驻留 cell 各拖全套进程群（cell server.js ~220-264MB + dsh runtime ~130-206MB + browser-mcp ~104MB + delegation/cron/actions/library 等 MCP 卫星各 ~70MB），**cell 数量 = 内存乘数**，OOM 是常态超售的必然结果。
- 现有观测面只有 `/api/monitoring/health` 报 gateway 自身 heapUsed——per-cell 进程分布完全不可见，问题只能靠 OOM 撞见。
- 准入链现状：cell 生灭走 gateway 的 durable registry + residency policy（`cell-gateway`「Cells start on demand」需求承载）；spawn/suspend/wake 决策证据有既有落点（lifecycle registry 的决策记录）。`agent-fleet-carrier` 的准入闸是回合级（FLEET_MAX_INFLIGHT），与 cell 驻留级是两条不同的闸。
- 环境约束：容器无 ps，/proc/statm 可读；cgroup v2 路径 `/sys/fs/cgroup/memory.current` + `memory.max`（v1 回落 `memory/memory.usage_in_bytes`）；macOS 开发/桌面无这些路径——必须降级。
- 配额现实：集群 compute-quota 16Gi 已用 15.5Gi，**提限（方案 A）单账号走不通**——本单不做内存限调整。

## Goals / Non-Goals

**Goals**：内存分布从「不可见」到「三层同框可读」；新驻留进 OOM 窗口前被拦下并给可读原因；降级路径零风险；为后续 B 线（cell 拓扑瘦身）提供选址数据。

**Non-Goals**：不改 MCP 卫星进程拓扑；不做 VPA/HPA；不迁移既有 cell；不做内存限调整；不做驱逐（闸只管新驻留）。

## Decisions

### D1: 计量源 = /proc 扫描 + cgroup 水位，零新依赖
`lib/proc-memory.js` 零依赖叶（沿 `pack-locale`/`market-annotations` 同纪律，gateway 与 cell 侧共用）：扫 `/proc/<pid>/statm` 取 RSS、`/proc/<pid>/cmdline` 取归属线索；cgroup v2 优先读 `memory.current/memory.max`，v1 回落。秒级 TTL 进程内缓存。
- **为什么**：26 进程扫描 <5ms，比起引 e2eB PFID 或 sidecar，读 proc 文件最便宜且生产/开发行为一致（macOS 无路径 → 如实返回不可用）。
- **备选**：cgroup freezer/per-cgroup cell 计量（拒：cell 进程不在独立 cgroup，k8s 只到 pod 层）；`/proc/<pid>/cgroup` 归组（同因不可用）。

### D2: cell 归组靠 cmdline 前缀匹配，不靠进程树
/proc 无父子可靠语义（卫星进程可能 re-parent）。归组规则：cmdline 含 `/data/cells/<cellId>/` 的进程归该 cell；含 `/opt/dsh` 且 patch 路径携带 cellId 的归该 cell；`gateway/index.js` 与无 cell 线索的归 gateway 桶。角色桶四类：`cell-server` / `dsh-runtime` / `mcp-satellite` / `gateway`。
- **为什么**：cmdline 是唯一稳定的 cellId 载体（spawn 参数带 patch 路径）；实测两条重 cell 的全部子进程 cmdline 都可归属。
- **风险**：cmdline 超 /proc 默认截断（实测 90 字符内含 cellId，够用）；进程短暂生命周期造成组抖动——读面按采样时点如实呈现，不做平滑。

### D3: 闸挂 gateway 的 spawn/resume 前置，拒绝走 lifecycle 证据通道
cell-gateway 的 spawn 与 park-resume 入口在启动前调 `proc-memory.headroom()`；低于阈值（env `CELL_MEMORY_ADMISSION_FLOOR`，缺省 0.15 即 15% 余量）拒绝并沿 lifecycle registry 既有决策记录写拒绝原因；计量不可用 → 放行 + warn（fail-open，沿 carrier 准入降级纪律）。
- **为什么挂 gateway 而非 cell 内**：spawn 决策者就是 gateway，cell 内检查为时已晚；阈值 env 与既有 FLEET_MAX_INFLIGHT 配置风格一致。
- **为什么 fail-open**：计量是本单新引入的辅助面，故障不得放大为业务阻断（沿「假正常修复」的失败可见纪律——告警必须出，闸必须开）。
- **备选**：只告警不拒绝（拒：实拍已证明常态超售，纯观测不解决 OOM 循环）；杀已驻留 cell（拒：违约 cell-lifecycle 的 resident 语义，破坏面大）。

### D4: 读面挂既有 monitoring 路由，驾驶舱只读渲染
`/api/monitoring/memory` 返回 `{container:{used,limit,headroomPct}, cells:[{cellId,totalMB,processes:[…]}], gateway:{…}, buckets:{…}, sampledAt}`；运维环内存卡复用既有 monitoring 轮询，无新推送通道。
- **为什么**：monitoring.js 已是集群/任务/健康读面的家；驾驶舱运维环已有轮询基建，加一张只读卡即可。

## Risks / Trade-offs

- [cmdline 归组误归（未来 spawn 形态变化）] → 归组规则集中在一个纯函数 + 单测钉住现有四类样张；读面同时透出「未归组进程」余量，漂移可肉眼见。
- [闸误拒高峰期用户] → 阈值保守（15% ≈ 230MB）+ 拒绝原因可读 + headroom 恢复即重试成功（spec 场景钉住）；阈值可调可关（env 置 0 即全放行）。
- [RSS ≠ cgroup 实际扣费（共享页重复计）] → 读面同时给 cgroup usage 与进程 RSS 合计，两者差值如实呈现；闸判定用 **cgroup usage**（内核真实口径），RSS 只做分布展示——避免按 RSS 误判。
- [扫描在 gateway 事件循环上] → 5ms 级同步读 + TTL 缓存，QPS 不放大；若未来进程数涨到百级再挪 worker。

## Migration Plan

1. lib 叶 + 读面（纯增量，随时可合）。
2. 闸接 spawn/resume（env 缺省启用，阈值 15%）；单测覆盖放行/拒绝/fail-open 三态。
3. 驾驶舱水位卡（只读）。
4. 回滚：env 置 0 即闸全开；读面回镜像即消失，无状态迁移。

## Open Questions

- B 线（cell 拓扑瘦身：卫星进程合并/按需起）等本单跑一周拿 per-cell 时序分布后再立项——哪些卫星进程可以懒起，数据说了算。
- `CELL_MEMORY_ADMISSION_FLOOR` 缺省 15% 是否合适，投产一周看拒绝率再调。
