# 给 cell 的磁盘占用定上限，别让一个租户把节点推过驱逐线

## Why

fd-prod 的 `liuliangjkiimypbdzxa` 只有 30 GiB，托管 48 个 cell，且 cell 的 workspace 与会话历史
**今天没有任何上限**。2026-11-09 实测：节点长期在 74%–90% 之间来回振荡，kubelet 的
`evictionHard: nodefs.available=5%`（约 1.5 GiB）+ `evictionMinimumReclaim: 10%`（约 3 GiB）
使它反复触发驱逐；facet 因 hostPath 钉死在该节点，被驱逐后停摆约 15 分钟，正在跑的回合被反复掐断。
**这种"贴着阈值来回踩"比一次性打满更伤**。

占用构成（同一节点实测）：

| 项 | 用量 | 性质 |
|---|---|---|
| containerd 全库 | 6.1 GiB | 可回收（镜像 GC 到 85% 才启动） |
| `/data/cells` | 5.6 GiB | **用户数据** |
| workspace 合计 | 1.1 GiB | 其中**单个 cell 占 1051 MiB**（内容生产产物：2400 章全文、导出、读者版） |
| sessions 合计 | 1.4 GiB | 会话历史，最可归档 |

结论：主因不是镜像，是**单租户内容产出 + 会话历史无配额增长**。

## What Changes

- cell 的 workspace 与会话历史 SHALL 有可见的用量与上限：超过软阈值如实提示（不静默截断），
  超过硬阈值时拒绝新的写入而不是让整个节点被驱逐。
- 会话历史 SHALL 有归档/滚动策略：把冷会话移出 pod 的 ephemeral 盘。
- 平台侧 SHALL 暴露每 cell 的磁盘用量（看板/告警），让"谁在长"可见。
- 基础设施侧（另一仓）：给该节点加 `systemReserved`/`kubeReserved` 的 ephemeral-storage，
  并把 `evictionHard` 的 nodefs 阈值抬高到与真实余量匹配的高度，避免振荡式驱逐。

## Impact

- 能力：`tenant-cell-runtime`（新增磁盘预算要求）
- 代码面（待实现）：cell 的写入路径（workspace / sessions）、用量采集与状态面
- 运维面：`fd-infra-deploy` 的节点 kubelet 配置、`ops-console` 的容量看板
- 不改变隔离模型：仍是"每 cell 一个根"，只是给这个根一个预算
