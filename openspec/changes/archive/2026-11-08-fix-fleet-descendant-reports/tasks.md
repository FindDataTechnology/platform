# Tasks — fix-fleet-descendant-reports

## 1. 更深层遍历与渲染（`server/fleet-context.js`）

- [x] 1.1 `collectDeeperDescendants(members, rootId, startDepth=2)`：BFS（近层优先）、visited 防环、
      路径取根节点真实标题
- [x] 1.2 `renderDeepBlock`：标题带层号与路径；槽值不带趋势；阻塞/摘要/时间；无报数写「（尚无报数）」
- [x] 1.3 段常量：`DEEP_TOTAL_LIMIT=6KB` / `DEEP_PER_POST_LIMIT=1KB` / `DEEP_MAX_POSTS=8` / `DEEP_MIN_ROOM=200`
- [x] 1.4 渲染位置：直接下级之后、本岗位往轮之前；计入 `used`；子池放不下时只写截断标记
- [x] 1.5 超量标注「另有 N 个更深层岗位因条数或总量上限未注入」

## 2. 测试

- [x] 2.1 新套件 `scripts/test-fleet-descendant-reports.mjs`（4 条）：三层可见孙辈 / 两层零变化 /
      子池不挤占直接下级 + 超量标注 / BFS 层号与防环
- [x] 2.2 既有契约更新：`test-fleet-report-lane`「only DIRECT children render」改为
      「不作为直接下级块渲染，但在更深层段带层号与路径出现」（44/44 绿）
- [x] 2.3 反证：把 `deeper` 置空 → 三层可见与子池两条红，两层零变化仍绿；装回 4/4 绿
- [x] 2.4 邻接：`test-fleet-report-lane`(44) / `test-fleet-decision-lane`(10) / `test-fleet-memory`(7) /
      `test-task-engine`(29) 全绿

## 3. 规格

- [x] 3.1 `agent-fleet-report-lane`：MODIFIED「巡视上下文注入」追加更深层条款 + 4 个场景

## 4. 上线

- [x] 4.1 快照 2d084d4 → GHA image ✅ → relay OK 4s → skopeo digest `sha256:64351eb0` → GitOps 31f58c0 →
      ArgoCD 对齐 → platform/facet 滚完 → **舱内跑本套件 4/4 绿**
- [x] 4.2 归档（`openspec validate --strict` 通过后）
