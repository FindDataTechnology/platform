# fix-fleet-failure-visibility Tasks

## 1. 数据面：连败区间一次查全

- [x] 1.1 `server/routes/fleets-db.js`：`consecutiveFailures` 扩为 `failureStreak(memberId)`，一次查询返回 `{ streak, since, lastErrorKind }`（`SELECT status, started_at, error_kind ... ORDER BY id DESC` 往回走，遇非 failed 即停）；旧 `consecutiveFailures` 保留为薄包装以免破坏既有调用方；验证：`node --test scripts/test-fleet-core.mjs` 绿 + 新单测断言三字段

## 2. 状态判定：新增 failing 档

- [x] 2.1 `server/fleet-reconcile.js`：`deriveMemberStatus` 增可选入参 `failureStreak`/`failureSince`/`lastFailureKind`，`on_duty` 分支在连败达阈值（`PLATFORM_FLEET_FAILING_STREAK`，默认 3）时返回 `failing`；evidence 增 `failureStreak/failingSince/lastErrorKind`；验证：单测覆盖「3 连败降级」「2 连败仍 on_duty」「中断不计入」「成功即恢复」「失联优先于 failing」
- [x] 2.2 `server/routes/fleets.js` `memberView`：把 `failureStreak` 三字段喂给 `deriveMemberStatus`，顶层透传 `failureStreak/failingSince/lastErrorKind`；验证：`GET /api/fleets/<id>` 的 member 对象含三字段且 failing 岗 status 正确

## 3. 统计口径对齐

- [x] 3.1 `server/routes/fleets.js` cockpit：`health.failing` 改由 `statusCounts.failing` 派生（删除「最近一回合失败」旧口径），`statusCounts` 自然含 failing；验证：单测造 3 连败岗位 → `statusCounts.failing===1` 且 `health.onDuty` 不含它

## 4. 前端可见

- [x] 4.1 `web/src/components/fleet/FleetCanvas.tsx` / `InspectorDrawer.tsx` / `web/src/pages/FleetsPage.tsx`：状态映射表补 `failing`（琥珀警示色 + 「需关注」文案），画布节点/岗位卡/检查器三处同色；检查器显示「连续失败 N 次 · 最近原因 <errorKind> · 自 <时刻>」
- [x] 4.2 五语言 locale（zh-CN/en/ja/es/fr）补 `fleets.status.failing` 与 `fleets.failure.{streak,since,lastKind}` 键；验证：`npm run check:locales` 全绿 + `npm --prefix web run typecheck` 无错

## 5. 收口

- [x] 5.1 全量单测 `node --test --test-concurrency=1 scripts/test-*.mjs`2108 测试 2099 绿；9 红全在既有 extension/manifest 族（HEAD 干净工作树复现证实为既有红）；`openspec validate` 通过
- [x] 5.2 出片上产sha-22c8deb（digest b8d938c2），GitOps 4b1e428 双清单滚完；in-pod 四标记 + 前端 bundle `inspector-failing` 全中，公网 200
- [x] 5.3 真机验收（需求稿口径）：生产 API 实测：跨境电商政策盯梢舰队·投稿岗 status=failing、streak=3、kind=runtime_not_ready、health.failing=1、statusCounts 从 normal 移出；台账 §15.54
