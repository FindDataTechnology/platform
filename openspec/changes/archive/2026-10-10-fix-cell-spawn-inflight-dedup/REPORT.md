# fix-cell-spawn-inflight-dedup — 实施报告（2026-10-10）

## 缺陷与根因

同一用户被 spawn 出**两个 cell 进程**，且都持有并写同一个 SQLite 索引库（2026-10-10 在
cheap-3 实测：`2b043ce050ca134c` 在 09:43 两秒内 spawn 两次，15:56 的 idle 回收只杀了记录里
的那个，另一个成为孤儿并存活至 16:45 之后）。

根因（`gateway/spawner.js`）：

1. `ensure()` 的去重守卫 `if (existing?.starting) return existing.starting` 依赖
   `cells.get(userId).starting`，但该 promise 是在 `spawnCell(user)` **返回之后**才挂上的；
   而 `cells.set(userId, cell)` 在 `spawnCell()` 内部、位于 `await freePort()` 与三个
   `await mkdir()` **之后**。启动窗口内到达的第二个请求读到的记录是 `undefined` → 守卫失效。
2. `spawnCell()` 的 `cells.set` 无条件覆盖，不终止旧 child。
3. 被覆盖的进程无人回收：其 exit handler 有 `if (cells.get(userId) !== cell) return;` 守卫，
   而 `stop()` 只 kill 记录里的 child。

## 修复

| 位置 | 改动 |
|---|---|
| `ensure()` | 新增 `inflight = new Map()`：**先登记 promise、后 spawn**；命中即返回同一条 promise；`finally` 无条件清理 |
| `spawnCell()` | 替换记录前，若既有 child 仍存活 → 标记 `stopping` 并 `await terminateChild()` |
| `terminateChild()` | 新辅助：SIGTERM → 5s 宽限 → SIGKILL，并**等待真实退出**（消除"记录已换、进程还在"的窗口） |
| `drop()` | 记录里仍有活进程时改走 `stop()`（而非静默删记录）——把"不留孤儿"的保证收到一处 |
| 启动失败路径 | `waitForPort` 失败时终止进程并清记录，不留 `starting` 幽灵（下一次 ensure 可正常重试） |
| `gateway/index.js` share-respawn | `registry.drop()` → `registry.stop()`：不再"只忘记录、留下活进程" |

## 验证证据

### 单测（`scripts/test-cell-spawner-dedup.mjs`，7/7）

用可注入的桩 cell（`START_DELAY_MS` 控制启动窗口）覆盖：并发首访收敛到一个进程、启动窗口内
第二次 ensure 不产生第二个进程、stop 后记录消失、**替换记录会终止旧进程**、启动失败不留幽灵
记录、两用户各自独立、per-user 根目录创建。

### 关键：测试确实能抓住原缺陷（反证）

把 `gateway/spawner.js` 临时换回修复前的版本（`git show HEAD:...`）重跑同一套测试：

```
✖ concurrent first requests collapse onto exactly one spawn     ← 两个进程，断言失败
✖ a second ensure during startup does not create a second process
✖ a cell that never listens fails ensure and leaves no stale record
ℹ pass 4  fail 3
```

三条失败正是本次修复的三个面（去重、替换、失败清理）；且该次运行在收尾时**挂死 180s**——
被遗弃的孤儿进程无人回收，恰是该缺陷在生产的形态。随后恢复修复版（md5 核对一致）。

### 既有回归

- `node --test scripts/test-cell-*.mjs scripts/test-gateway-*.mjs`：**19/19 通过**
  （含真实网关端到端：认证、路由、WS 粘性、重启恢复、idle 回收、优雅退出、workspace pin）；
- `npm run test:unit`：**979/979 通过**；
- `npx biome check`：零告警。

## 尚未完成（生产窗口，需人工）

- 3.1 滚动前确认 fd-prod `compute-quota` 余量 ≥2Gi（10-07 满配额坑）；
- 3.2 镜像滚动上线；
- 3.3 清理现存孤儿（宿主 pid 86793）并确认每用户单进程；
- 3.4 复现性验证：制造一次并发首访，断言日志只有一条 `running on`；
- 3.5 归档前 `openspec validate --strict` 复跑。

## 与另两个 change 的关系

本 change 是 `rebuild-chat-index` 生产执行的前置：重建要求目标库是单写者，而修复前的 spawner
仍会制造孤儿进程去并发写新建的库。发布顺序：**本 change 先行** → 滚部署 → 再执行重建。

---

## 生产执行记录（2026-10-10 22:38 起，镜像 sha-61e44f7）

**滚动方式**：deployment 是 `strategy: Recreate`（无 surge），所以换镜像 = 旧 pod 整体销毁重建。
这同时**顺带清掉了历史孤儿**：旧 pod 里的孤儿 cell 进程（宿主 pid 86793）随 pod 一起消失。

**清后核对**（cheap-3 宿主 `ps` + `/proc/<pid>/environ`）：

- 平台 pod 内只有一个 gateway 进程（22:38 起）+ 一个 cell 进程（`0f483a072f22ae37`，22:38 起）；
- 小说 cell `2b043ce050ca134c` **未被自动 spawn**（无流量即不 spawn），因此重建期间它是停的
  —— 单写者前提天然满足；
- 重建完成后按需起了一次临时 cell 做验收，验收后已 SIGTERM 停掉并确认进程消失。

**部署前配额检查**：`fd-prod/compute-quota` = limits.memory 16352Mi/20Gi（余 ~3.6Gi）、
limits.cpu 9700m/12 —— 健康，Recreate 不额外占 surge 配额。

**留档**：本次未人为制造并发首访（生产不宜），并发去重由单测在修复前/后两版上的对照证明
（修复前 3 条失败 + 收尾挂死 180s；修复后 7/7 绿），见上文"反证"节。
