# Proposal — fix-fleet-descendant-reports

## Why

舰队里「报数可见性 = 直属下级一层」（explore §4.3 / P2-1）。这条不是没实现，是**只实现了这一层**，
而且**没有第二条路**：全仓没有任何工具能让一个岗位读到别的岗位的报数（`server/fleet-mcp.js`
只有 `report_status` / `escalate` / `dispatch_post` / 决策三件）。于是：

- 三层舰队（总编 → 主编 → 撰稿）里，总编只能看见主编的报数；撰稿的阻塞项、槽值要**靠主编在
  自己的报数里转述**才可能到达。主编偷懒或转述失真 = 总编对着残缺状态做决策。
- 四层以上同理，越往下越不可见。
- 两层舰队（**现网全部 6 套官方模板都是两层**：1 根 + 直属）不受影响——这也是它一直没被发现的原因。

## What Changes

- `buildFleetContext` 在直接下级段之后追加**更深层报数段**（第 2 层及以下），每条为**紧凑块**：
  标题（含层级与路径，如「撰稿（第 2 层｜总编 > 主编）」）、声明槽值、阻塞项、摘要、报数时间；
  **不**带趋势箭头，**不**查 prev（每多一条深块就多一次查询，换来的是岗位卡片上已有的数字）。
- 段有**独立子池**（6KB / 单块 1KB / 最多 8 块），排在直接下级之后——直接下级的预算不可能被它挤占
  （那段循环已经跑完）。截断与超量 SHALL 显式标注（「另有 N 个更深层岗位因条数或总量上限未注入」）。
- 两层舰队下该列表为空 → **不渲染任何段**（不出现标题、不出现截断标记），上下文逐字节不变。
- 遍历为 BFS（近层优先）+ visited 集合（畸形 `parentId` 链不会挂死巡视回合）。

## Impact

- Affected specs: `agent-fleet-report-lane`（MODIFIED：巡视上下文注入 —— 追加更深层条款与 4 个场景）
- Affected code: `server/fleet-context.js`（`collectDeeperDescendants` + `renderDeepBlock` + 段渲染）
- 既有测试契约变更 1 处：`test-fleet-report-lane` 的「only DIRECT children render」由「孙岗完全不可见」
  改为「孙岗不作为直接下级块渲染，但在更深层段里带层号与路径出现」——这正是本 change 要改的那条。
- 无迁移、无新表、无新工具、无新 env。
