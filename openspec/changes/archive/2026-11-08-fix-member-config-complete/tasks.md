# Tasks — fix-member-config-complete

## 1. 建岗接全配置维度（`server/routes/fleets.js`）

- [x] 1.1 POST 建岗在 `db.createMember(...)` 之前读 `effort`/`contextBudget`/`carrier`/`packId`
- [x] 1.2 effort/contextBudget 走 `validateConfigDims({…}, effortUnionFrom(ctx?.dshModels))`，
      与 PATCH `:3167` 同一函数、同一参序；`dims.error` → 400 且不落库
- [x] 1.3 `carrier` 走 `CARRIERS.includes` 枚举门；`packId` 走「非空串 ≤64」形状门，
      文案与 PATCH `:3175-3185` 逐字对齐（避免同一错误两种说法）
- [x] 1.4 四项在 `createMember({...})` 里落地：`undefined` → 不写（落 `null`），
      `null`/`""` → 清（`validateConfigDims` 已把 `""` 归一为 `null`）

## 2. 清档即回到全局（`server/cron-runner.js`）

- [x] 2.1 判据从真值改为目标值比较：
      `const desired = plan.effort ?? null; if (desired !== (ctx.currentEffort ?? null)) { … }`
- [x] 2.2 调用点改成 `ctx.switchEffortTo?.(desired)`；notice 文案在 `desired === null` 时
      写成「clear → provider default」，不要打印 `'null'`
- [x] 2.3 降级语义不动：切换失败仍只进 `effortNotices` 并放行回合

## 3. 测试

- [x] 3.1 `scripts/test-fleets-api.mjs`（或既有舰队路由测试文件）补建岗四例：
      ①建岗带四个合法值 → 201 且读面逐项回显 ②非法 effort → 400 且岗位未创建
      ③未知 carrier → 400 ④超长 packId → 400
- [x] 3.2 建岗/改岗等价断言：建岗带 `effort: X` 与「建岗后 PATCH `effort: X`」两种路径
      读面结果相同（防止两处各长一套）
- [x] 3.3 `scripts/test-fleet-turn-budget.mjs` 或 `test-fleet-orchestration.mjs` 补
      「清档回合」用例：`plan.effort=null` 且 `currentEffort='high'` → 断言调用了
      `switchEffortTo(null)`；`plan.effort=null` 且 `currentEffort=null` → 断言**未**调用
- [x] 3.4 **反向证明**：把 2.1 改回真值判断，3.3 的第一条必须红；恢复后全绿

## 4. 门禁

- [x] 4.1 `npx biome check server/routes/fleets.js server/cron-runner.js <测试文件>` 绿
- [x] 4.2 `openspec validate fix-member-config-complete --strict` → `is valid`
- [x] 4.3 相关套件全绿；全量逐文件扫（**每文件 100s 超时**，425 文件 / 3858 条）
      = **3857 绿 / 1 红**：唯一红 `scripts/test-bench-proposal-client.mjs`（bench 面，
      隔离重跑 3 次全绿 = 顺序/端口竞争，与本变更无交集）；2 个既挂超时
      （`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）。
      基线三红（connector 3.2/2.3、websearch lane 3）已由并发线 `31e202c8b` 修掉

## 5. 上线

- [x] 5.1 出片滚版 → 已在产（快照 `29ffe0607` → GHA `sha-d41ac58`，直接落 `law-bench` 命名空间；
      digest `sha256:cff1c678`，relay OK 05:03；fd-infra-deploy `c66f635` 双 bump → ArgoCD → 两 rollout 完成；
      镜像内 `test-agent-config-dims` 14/14 绿 + 实弹探针 `applyPostEffort(effort:null)` 发出 `switchEffortTo(null)`）
- 5.2 观察项（滚版后，非本 change 交付物）：真实业务岗上带 `effort`+`carrier` 建岗并核对读面回显；
      置 null 后看一回合的 `effort_changed` 事件是否落到 provider 默认（探针已证路径，业务面待自然发生）

## 6. 挂账（不在本变更）

- 6.1 Web 建岗对话框是否要露出这四个字段（人机流程另裁，见 design D3）
- 6.2 `contextBudget` 目前只事后判超、不进请求（explore §3.1 既有事实），与本变更无关
