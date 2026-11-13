# Tasks — add-event-wake-coalesce

## 1. 窗口与合并（`server/fleet-event-wake.js`）

- [x] 1.1 `coalesceWindowMs()`：`EVENT_WAKE_COALESCE_MS`，默认 800，非法值回落，`0` = 关闭
- [x] 1.2 `mergeWakeMessages(messages)`：最近 8 条、`\n---\n` 分隔、4000 字截断带标记、
      略去条数显式声明、发言人取最后一位、`addressed` 取并
- [x] 1.3 入口改为缓冲：按 `${botId}:${chatKey}` 入槽，窗口关闭时 `deliverFleetEventWake` 一次
- [x] 1.4 定时器 `unref()`；`flushEventWakes()` 立即兑现（测试/优雅停机）
- [x] 1.5 `coalesced` 进 `origin.event`（仅 >1）与准入处置行（仅 >1）

## 2. 既有测试的契约调整（不是放宽，是显式化）

- [x] 2.1 `test-fleet-turn-mandate`：显式 `EVENT_WAKE_COALESCE_MS=0`（它测准入层，需同步契约）
- [x] 2.2 `test-fleet-event-wake`：同上（它测溯源段与频次护栏的形状）
- [x] 2.3 `test-bots-event-wake`（端到端）：无需改——它的 `waitFor` 容忍 4s，800ms 窗口自然兑现

## 3. 测试（`scripts/test-event-wake-coalesce.mjs`，5 条）

- [x] 3.1 合并纯函数：片段保留、空白片段丢弃但仍计数、最后发言人、addressed 取并
- [x] 3.2 合并纯函数：11 条 → 保留 8、声明略去 3；超长 → 截断标记且总长有界
- [x] 3.3 窗口：同会话三条 → 窗口内零任务、flush 后**一个**任务、`coalesced=3`、正文含三条、
      且 `{{fleetEdgeContext}}` 仍在末尾
- [x] 3.4 窗口：两个会话 → 两个任务、互不包含、单条不带 `coalesced`
- [x] 3.5 关闸：`=0` → 同步逐条建任务（旧契约）、`flushEventWakes()` 为空操作
- [x] 3.6 **反向证明**：入口直接透传（跳过窗口）→ 3.3 红；恢复后 5/5 全绿

## 4. 门禁

- [x] 4.1 `npx biome check server/fleet-event-wake.js scripts/test-event-wake-coalesce.mjs` 绿
- [x] 4.2 `openspec validate add-event-wake-coalesce --strict` → `is valid`
- [x] 4.3 全量逐文件扫（每文件 100s 超时，隔离克隆内）：440 文件 / **3944 条全绿、零红**；
      仅 2 个既知超时（`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）。
      并发线此前修掉了那两处旧判据，故本轮连"已知红"都没有

## 5. 上线

- [x] 5.1 出片滚版 → 已在产（快照 `963400e`，digest `sha256:f3adfdee`，relay 30s 到位；
      ⚠️ 我自己出的 `546e94b` 构建被并发线的新快照取消（同一并发组），但他们的快照基线
      `9ce29929f` **就是**我的提交，故直接滚他们的片子；fd-infra-deploy `953bc67` 双 bump
      → ArgoCD 75s → 两 rollout 完成；镜像内 5/5 绿；实弹探针：窗口默认 800ms、
      合并 2 条 `coalesced=2`、发言人取末位、addressed 取并、正文以 `---` 分隔）
- [ ] 5.2 观察项：滚版后看一次真实连发，确认只起一个回合、`coalesced` 与处置行对得上

## 6. 挂账（不在本变更）

- 6.1 缓冲只在内存：窗口内进程退出会丢掉尚未承认的突发（窗口 800ms）
- 6.2 合并上限（8 条 / 4000 字）为常量，未做成舰队级可配
