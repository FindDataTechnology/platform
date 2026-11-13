## Why

平台里集群的机器全部在（fleet 一等对象、cockpit、KPI 报数、拍板车道、模板市场分发、多机经 cell 跑），但都是「机器能看」不是「主人能经营」：集群主人没有一个面能看见自己组织的集群在跑什么、报了多少数、哪里要拍板、花了多少钱；模板从市场到首跑还缺装作路径（web 端没有任何组件调用 `/api/fleets/from-template`）。2026-10-27 产品线裁决（需求书 `docs/fleet-owner-surface-requirements.md`，用户补充：花销造账纳入本版、粗粒度即可）：做一层主人视角的「经营坞」，接入既有机制、不造新运行时。迭代回路（改动提议→审批→再铸 vN+1→订阅跟新）由姊妹单 `add-fleet-owner-iteration` 承担。

## What Changes

- **集群总览坞**（P0）：owner 视角的组织级集群清单——每集群在跑/暂停/异常状态、异常与告警入口（拍板待办与 failing 岗位直达）、跨机运行占位显示（休眠 cell 显式占位行，不再 honest absence 隐身）。
- **经营读数**（P0）：每集群 KPI 槽位报数读面（复用 L1 槽位键契约与 `buildLatestView`）+ 拍板排队与动作入口整合进坞面。
- **花销视图**（P0，粗粒度造账）：每集群 token 事实投影（`fleet_runs`/`member_turn_events` usage）+ 粗粒度金额（集群岗位部署 key 的 sub2api 消耗对账，周期快照）+ 市场行（模板购买/订阅成交记，消费侧，依赖 `add-market-revenue-share`）。
- **模板装作路径**（P0）：市场集群模板卡 → 默认参数向导 → `from-template` 实化 → 首跑点燃，与 ClusterComposerModal 同组件族，装完即入总览坞。
- **契约增量**：fleet 模板可声明默认参数槽（`manifest.fleet` 可选 `params` 段），向导与实例化器按槽消费。

## Capabilities

### New Capabilities

- `fleet-owner-surface`: 主人经营坞——总览坞、经营读数、花销视图、装作路径与失败如实分类。

### Modified Capabilities

- `agent-fleet-templates`: 模板可声明默认参数槽（`manifest.fleet.params` 可选段），实例化器按槽消费、缺省走默认。

## Impact

- **后端**：`server/routes/fleets.js`（owner 聚合/花销读面）、`server/fleet-template.js`+`fleet-provisioner.js`（参数槽消费）、gateway `fleet-cells.js`（cell 注册表×采样差集占位）、周期对账任务（jobs 引擎）。
- **前端**：`web/src/pages/FleetsPage.tsx` 族 + 市场模板卡装作入口与参数向导组件（新文件）；措辞遵循叙事层 change 诚实口径（职责变了，不说接管一切）。
- **依赖**：花销视图市场行依赖 `add-market-revenue-share` 的成交记；跨机占位可借力在跑的 `add-cell-lifecycle`（steward 常驻让 cell 名录更准，非硬阻塞）；归档排序注意 `add-fleet-ops-canvas` 同样动 `agent-fleet-cockpit` 邻域。
- **明确不在范围**：迭代回路/再铸发版（`add-fleet-owner-iteration`）；日报/周报外发推送（同上）；L3 蓝图编辑器（finddata 另案）；多机运行时改造（既有事实只需可见）。
