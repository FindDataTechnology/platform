# Tasks — budget-cell-disk-usage

## 1. 实证（已完成）

- [x] 1.1 定位节点 `liuliangjkiimypbdzxa`：30 GiB，长期 74%–90% 振荡，触发过 facet 驱逐停摆约 15 分钟
- [x] 1.2 取到真实驱动：`evictionHard nodefs.available=5%` / `evictionMinimumReclaim=10%` /
      `imageGCHighThresholdPercent=85`
- [x] 1.3 拆出占用构成：containerd 6.1 GiB、cells 5.6 GiB（workspace 1.1 GiB 中单 cell 1051 MiB、
      sessions 1.4 GiB）——**镜像不是主因**
- [x] 1.4 确认 workspace 里是用户真产出（长篇小说全文/导出/读者版），不是垃圾，不可删

## 2. 实施

- [x] 2.1 用量采集：`gateway/cell-disk.js` 量每 cell 的 workspace / `dsh/sessions`（`lstat` 走查，
      **符号链接不计**——否则一个 cell 会报出另一个 cell 的字节）；TTL 缓存（默认 5 分钟）避免
      每次状态请求遍历 48 个根；`spawner.statusWithDisk()` 把读数并进 `GET /api/gateway/status`，
      软/硬阈值经 `CELL_DISK_SOFT_MB` / `CELL_DISK_HARD_MB` 配置（默认 512 MiB / 2 GiB，按实测单 cell 1051 MiB 定档）
- [x] 2.1b 三态判定 `ok/near/over`（软、硬阈值均含边界；负数读数不当 over）；单测
      `scripts/test-cell-disk-budget.mjs` 5/5，其中符号链接那条当场抓到我自己写错 `stat` 的实现
- [ ] 2.2 硬阈值拒绝写入——**未做**：写入点分散在 agent 运行时与文件路由，先要定"在哪一层拒"
      （工具调用前 / 文件写入路由 / 只拦上传）。当前只到"如实显示 over 状态"，不做平台代删：
      workspace 里是用户真产出，任何静默清理都是事故
- [ ] 2.3 会话历史归档/滚动：冷会话移出 pod 的临时盘（目录可配置，默认保留近 N 天）
- [x] 2.4 单测：阈值判定（含边界/负数）、采集在目录缺失时为 0 不抛、符号链接不计、
      TTL 命中与过期刷新、`snapshot()/invalidate()` 行为

## 3. 基础设施（host 级，需运维执行——我这边无节点权限）

实测该节点（`liuliangjkiimypbdzxa`）的 kubelet 现状：

| 项 | 现状 | 问题 |
|---|---|---|
| `systemReserved` / `kubeReserved` | **都没设** | `allocatable` 等于 `capacity`（30.5G/29.9G），没有任何缓冲带 |
| `evictionHard` | `nodefs.available: 5%`（≈1.5G） | 与 10% 回收目标一起，形成"贴线反复驱逐" |
| `evictionSoft` | 未设 | 没有软性预警带，只有硬驱逐 |
| `enforceNodeAllocatable` | `["pods"]` | 正常 |

- [ ] 3.1 给节点加 ephemeral-storage 预留（`/etc/rancher/k3s/config.yaml`，改完 `systemctl restart k3s`）：
      ```yaml
      kubelet-arg:
        - "system-reserved=ephemeral-storage=2Gi"
        - "kube-reserved=ephemeral-storage=1Gi"
        - "eviction-hard=nodefs.available<15%,imagefs.available<10%"
        - "eviction-soft=nodefs.available<20%"
        - "eviction-soft-grace-period=nodefs.available=2m"
        - "eviction-max-pod-grace-period=30"
      ```
      让驱逐发生在还有余量时、且先软后硬，而不是贴着 1.5G 反复抖。
      注意：**预留会降低 allocatable**，该节点已有 pod 的 request 需复核（当前 requests 很低，影响可忽略）。
- [ ] 3.2 改完复核——**判据已修正**：原写"`allocatable` 应小于 capacity"是无效判据，因为该差值今天
      就已存在（实测 2026-11-09：capacity 31390700Ki=32,144,076,800 B，allocatable 30,536,872,937 B，
      差 1.497 GiB，恰好等于 `evictionHard nodefs.available<5%` 扣掉的量，与 allocatable 仅差 23 B 取整）。
      正确判据二选一：
      ① 比较「capacity − 5% 驱逐阈值」与真实 allocatable 的**残差**：改前 ≈ 0，改后应 ≈ 3 GiB（2Gi+1Gi 预留）；
      ② 直接读节点 `/etc/rancher/k3s/config.yaml` 的 `kubelet-arg`，确认三条预留行存在。
      另需观察 24h 内 `DiskPressure` 不再翻转、无 pod 被驱逐。
- [ ] 3.3 该节点还托管 facet（hostPath 钉死），建议后续把 facet 迁到独立节点或改用 PV，
      避免"节点磁盘问题 → 市场面停机"这种耦合。
