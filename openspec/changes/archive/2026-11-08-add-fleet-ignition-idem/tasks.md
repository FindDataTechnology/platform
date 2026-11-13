# Tasks — add-fleet-ignition-idem

## 1. 点火键（`server/fleet-handoffs.js`）

- [x] 1.1 `export function ignitionTurnKey(job, ledgerTurn)`：`ledgerTurn.turnId` → `${job.id}:r${roundSeq}`
- [x] 1.2 `firedIgnitionKeys(engine)`：回读 `origin.fleet.ignition`（读失败降级为"无历史"）
- [x] 1.3 `hopKey(edgeKind, targetId)` = `${turnKey}:${edgeKind}:${targetId}`
- [x] 1.4 三个 hop 分支（接棒 persona/a2a、接棒 tool、扇出）建任务前判重 + 跳过
- [x] 1.5 判重放在**深度越界事件行之前**，重复进入不刷第二条 bound 行
- [x] 1.6 每个 hop 把键写进 `origin.fleet.ignition`

## 2. 语义边界（写清，不藏着）

- [x] 2.1 键以**回合**为单位：运维重跑 / 下一轮节奏 = 新回合 = 照常点火
- [x] 2.2 已知边界两条写进 design：① 下游任务被删后键消失，同回合可重造该 hop；
      ② 重启后恢复的轮次拿到新 `roundSeq`，与重启前的点火键不同（会被当新回合）

## 3. 测试

- [x] 3.1 `scripts/test-fleet-orchestration.mjs`：同回合二次进入 → `null`（不建任务）、
      溯源键形态 `turn:(handoff|fanout):id_*`、新回合仍两跳、无账本时按执行序号去重、
      序号递增即新回合
- [x] 3.2 `scripts/test-fanout-aggregation.mjs`：两次"波"显式给不同 `ledgerTurn.turnId`
      （否则会被幂等判为同一回合——这本身就是正确语义，测试跟着改）
- [x] 3.3 **反向证明**：删掉接棒分支的判重两行 → 3.1 红；恢复后全绿
- [x] 3.4 相邻套件：`test-fleet-orchestration` 18、`test-fanout-aggregation` 5 全绿

## 4. 门禁

- [x] 4.1 `npx biome check server/fleet-handoffs.js scripts/test-fleet-orchestration.mjs scripts/test-fanout-aggregation.mjs` 绿
- [x] 4.2 `openspec validate add-fleet-ignition-idem --strict` → `is valid`
- [x] 4.3 全量逐文件扫（每文件 100s 超时）：427 文件 / **3870 条全绿、零红**；
      仅 2 个既知超时（`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）

## 5. 上线

- [x] 5.1 出片滚版 → 已在产（快照取自远端线 61e406783 → GHA `sha-0b02f37`，digest `sha256:7f35faf1`，
      relay 60s 到位；fd-infra-deploy `43e2251` 双 bump → ArgoCD → 两 rollout 完成；
      镜像内 `test-fleet-orchestration` = 18/18 绿，`ignitionTurnKey`/`firedIgnitionKeys` 均在）
- [ ] 5.2 观察项：滚版后查一次重试回合，确认下游任务数不翻倍、溯源键可读

## 6. 挂账（已知边界，不在本变更）

- 6.1 下游任务被清理后点火键随之消失 → 同回合再次进入会重造该 hop（要更严需墓碑表）
- 6.2 重启恢复的轮次拿新 `roundSeq`，与重启前点火键不同（跨重启的回合身份需账本持久化）
