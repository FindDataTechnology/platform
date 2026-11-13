## ADDED Requirements

### Requirement: 容器内存三层分布读面

platform 容器 SHALL 提供内存分布读面：容器层（cgroup usage 与 limit 及余量百分比）→ cell 层（每个驻留 cell 的进程 RSS 合计与其进程清单）→ 进程层（pid、进程名、RSS、角色桶）。进程 SHALL 按 cellId 归组——cell 平台进程（cmdline 携带该 cell 数据路径）与其子进程（dsh runtime、MCP 卫星）归入同一 cell；不携带 cell 数据路径的 node 进程归入 gateway 桶。读面 SHALL 只读，采样 SHALL 有进程内缓存（秒级 TTL），高频请求 MUST NOT 放大扫描开销。

#### Scenario: 三层分布同框可见

- **WHEN** 运维者读取内存分布读面
- **THEN** 响应含容器 usage/limit/余量、每个驻留 cell 的 RSS 合计与进程数、以及每进程的 pid/名/RSS/角色桶

#### Scenario: cell 子进程归组到宿主 cell

- **WHEN** 某 cell 的 dsh runtime 或 MCP 卫星进程在采样窗口内存在
- **THEN** 其 RSS 计入该 cell 的合计而非 gateway 桶，进程行可读出归属

#### Scenario: 缓存窗口内重复读不放大扫描

- **WHEN** 读面在缓存 TTL 内被连续请求多次
- **THEN** 只执行一次 /proc 扫描，响应同源于缓存

### Requirement: 内存准入闸与 fail-open

新 cell 驻留（provision 与 park-resume）SHALL 在准入检查中查容器内存余量：余量比例低于阈值时 SHALL 拒绝驻留并透出可读原因（当前用量、limit、余量、阈值）；阈值 SHALL 可配（env，缺省保守值）。计量缺失或读值异常时 SHALL fail-open——放行并告警，与既有 carrier 准入闸的降级纪律同构。已驻留 cell MUST NOT 被本闸驱逐（闸只管新驻留）。

#### Scenario: 余量充足放行

- **WHEN** 容器内存余量高于阈值时一个新 cell 请求驻留
- **THEN** 驻留照常发生，行为与本闸未引入前一致

#### Scenario: 余量低于阈值拒绝并给原因

- **WHEN** 容器内存余量低于阈值时一个新 cell 请求驻留
- **THEN** 驻留被拒，响应/事件携带当前用量、limit、余量与阈值的可读原因

#### Scenario: 计量缺失 fail-open

- **WHEN** cgroup 或 /proc 计量不可读（路径缺失、值异常）
- **THEN** 驻留放行，系统告警记录计量缺失，不得因计量故障阻断业务

### Requirement: 运维坞内存审计渲染

驾驶舱运维环 SHALL 渲染容器内存水位（当前用量对 limit 的比例）与 per-cell 分布摘要；余量低于阈值 SHALL 以琥珀提示呈现（含原因），水位正常时不渲染警示。渲染 SHALL 为只读面，MUST NOT 提供任何写操作。

#### Scenario: 水位正常不示警

- **WHEN** 容器内存余量高于阈值
- **THEN** 运维环呈现水位与分布摘要，无警示标记

#### Scenario: 低余量琥珀提示

- **WHEN** 容器内存余量低于阈值
- **THEN** 运维环以琥珀标记水位卡并透出当前用量/limit/余量，cell 分布按 RSS 降序可读

### Requirement: 计量零侵入与兼容

内存计量 SHALL 只读 /proc 与 cgroup 文件，MUST NOT 向被计量进程注入探针或改变其运行；非 Linux 环境（macOS 开发/桌面）SHALL 如实降级（读面返回计量不可用标记，准入闸 fail-open），行为与本计量未存在时一致。

#### Scenario: 非 Linux 环境如实降级

- **WHEN** 平台运行于无 /proc 计量源的环境（macOS 开发/桌面打包）
- **THEN** 内存读面返回不可用标记而非报错，cell 驻留不受阻断
