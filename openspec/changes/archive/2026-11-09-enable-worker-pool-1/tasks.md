# Tasks — enable-worker-pool-1

## 1. 前提核对（算术）

- [x] 1.1 cgroup `memory.max=7Gi` / `current≈2.14Gi` / 余量 ≈5.0Gi（pod 内实测）
- [x] 1.2 闸门槛 `7Gi×0.85=5.95Gi` vs `used+足迹≈4.07–4.16Gi` → 放行
- [x] 1.3 对照 11-08 的 4Gi 失败形态（门槛 3.4Gi < 4.07Gi），确认本次条件不同

## 2. 改配置

- [x] 2.1 `platform.yaml`：`TASK_WORKER_MAX` 0 → 1，注释写清依据/回滚（改 GitOps 真源，非 kubectl patch——
- [x] 2.2 ArgoCD 对齐 → rollout → 舱内确认：三个 cell 均 `[worker-pool] active, TASK_WORKER_MAX=1`

## 3. 观测

- [x] 3.1 **并行实证**：连发 3 条不同岗位任务，队列采样 6 次（每 8 秒）持续 `running=2`（一主链 + 一 worker），`overBudget=0`
- [x] 3.2 池内真实 spawn：`[worker-pool] spawned worker-1 for persona hotel-watch-chief` / `xb-poster`（按 persona 亲和，非空转）
- [x] 3.3 内存守住：`memory.current` 1.76–2.14Gi / 7Gi（开池后不升反降，因重启后按需唤醒）；无 OOM/拒醒
- [x] 3.4 回滚路径已验证可用：改回 `"0"` 即池 vacuous（`attachWorkerPool` 在 cap 0 直接返回 inert，行为与开池前逐字节一致）

## 4. 归档

- [x] 4.1 `openspec validate --strict` → 归档
