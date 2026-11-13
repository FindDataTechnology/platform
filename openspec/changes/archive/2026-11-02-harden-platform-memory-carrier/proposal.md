## Why

platform 主 pod（gateway + 多 cell 共容器，1536Mi limit）在滚版前后持续连环 OOMKilled（老代 12h 重启 11 次、新代 40min 6 次，台账 §15.124 补记）。2026-11-02 生产 pod 进程级 RSS 实拍（/proc 扫描，26 进程总和 2261MB vs limit 1536Mi）：每个驻留 cell 拖一整套 node 进程群（server.js ~220-264MB + dsh runtime ~130-206MB + browser-mcp ~104MB + delegation/cron/actions/library 等 MCP 卫星各 ~70MB），**cell 数量是内存乘数**——两个驻留 cell 即常态超售，OOM 是结构性必然而非泄漏。现有观测面（`/api/monitoring/health`）只报 gateway 自身 heap，完全看不见 cell 进程分布，问题只能靠撞见。

## What Changes

- **per-cell 进程内存计量**：gateway 周期采样容器内全部 node 进程的 RSS（/proc/statm 扫描，零新依赖），按 cell 归组（server.js cwd/args 中的 cellId + 其子进程 dsh/mcp 卫星），落 `/api/monitoring/memory` 读面（pods → cells → processes 三层分布 + 容器 cgroup usage/limit 对比值），并留进程名聚合（dsh/mcp-server/cell-server/gateway 四桶）。
- **cell 驻留内存闸**：fleet carrier 准入链（复用 `fleet-carrier` 的 admission 缝）增内存检查——新 cell 驻留（provision/park-resume）前查当前容器内存余量（cgroup usage 对 limit 的余量低于阈值的，拒绝驻留并给可读原因），fail-open 语义沿 carrier 既有约定（计量缺失不拦截，只告警）。
- **cell 内存审计面接入运维坞**：驾驶舱运维环显示容器内存水位与 per-cell 分布（只读，随现有 monitoring 面走），超阈值琥珀提示。
- **明确 Non-goals**：不改 MCP 卫星进程拓扑（合并/按需起属后续 B 线，本单先拿数据）；不做 k8s 层 VPA/HPA；不做重 cell 迁移本身（数据齐后另行立项）；不动注释层与本计量无关面。

## Capabilities

### New Capabilities

- `platform-memory-observability`: platform 容器内存承载契约——per-cell 进程 RSS 采样与归组、cgroup 水位读面、内存准入闸（阈值/余量判定/fail-open）、运维坞内存审计渲染。

### Modified Capabilities

- `fleet-carrier`: cell 驻留准入链增内存闸——驻留前余量检查、拒绝原因透出、fail-open 与既有准入闸同构。

## Impact

- **Server（壹座）**：`server/routes/monitoring.js` 增 `/api/monitoring/memory`（/proc 扫描 + 归组 + cgroup 读值）；新 lib 叶 `lib/proc-memory.js`（扫描/归组/缓存，网关与 cell 侧共用）。
- **cell 驻留链**：cell provision / park-resume 路径挂内存闸（读 lib/proc-memory 的余量判定），拒绝经既有 carrier 准入拒绝通道透出原因。
- **Web（壹座）**：驾驶舱运维环内存水位卡（数据来自 monitoring 读面，复用既有轮询）。
- **出片**：无新文件 COPY（lib/ 全量已入镜像）；测试新 script 纳入 `test:unit` glob。
- **协调面**：`fleet-carrier` 归档 spec 的准入闸场景需 MODIFIED（增内存维度）；台账 §15.124 的内存限挂账由本单承接收口。
