# Tasks — fix-worker-session-rotation

## 1. 修复

- [x] 1.1 worker 回合 prompt 改用 `roundChildSessionId(...)`（与主链同一推导）
- [x] 1.2 镜像 id 保留给转写/标题（行为不变）
- [x] 1.3 `worker.currentSession` 改为 child id —— `pumpFor()` 与槽位看门狗都靠它查 collector/abort

## 2. 测试

- [x] 2.1 新增「worker 回合用轮转子会话、不用镜像 id」用例（`test-worker-pool` 13 条）
- [x] 2.2 反证：退回不轮转 → 该用例红；还原 13/13 绿
- [x] 2.3 邻接：`fleet-runs`(26) / `cron-round-rotation`(5) / `fair-queue`(12) / `fleet-context-pressure`(12) / `task-engine`(31) 全绿

## 3. 规格

- [x] 3.1 `worker-pool`：轮转条款 + 2 场景（含「两 worker 不得共用同一会话」）

## 4. 上线

- [x] 4.1 快照 21159b6 → GHA ✅ → relay → digest sha256:b351d419 → GitOps 40e3632 → ArgoCD → 舱内 `rotation=2 / spill=4 / worker=3`。
      **观测**：`already owned` 累计 7 条全部落在 11:48–**14:08**Z，而修复镜像 **14:12:55Z** 才上线 → **修复后 0 条**。
      同批 5 回合 **5 ok / 0 failed（100%）**，且单条输出实测 11–12KB（此前 40–43KB，内联预算生效）
- [x] 4.2 归档
