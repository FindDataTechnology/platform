# Proposal — fix-member-config-complete

## Why

建岗接口对四个配置维度**静默丢值**：`POST /api/fleets/:fid/members` 只读
`title/parentId/targetKind/targetId/kpiSlots/cadence/model/fallbackModel`
（`server/routes/fleets.js:3037-3094`），而同一岗位的 PATCH 面接受
`effort/contextBudget/carrier/packId`（`:3120,3167-3185`）。带这四项建岗会得到
**201 + 值全丢 + 零报错**——调用方（脚本、代采单创建流程、A2A 侧建岗）以为自己配好了，
读面回 `null`。

第二处是**清档不生效**：`effort` 置 `null` 后，回合侧用真值判断跳过切换
（`server/cron-runner.js:476` `if (plan.effort && …)`），运行中思考深度保持上一岗遗留的
档位，而不是回到 provider 全局值。声明"清掉了"，活体没清。

两处都不是新愿望，而是**既有规格没被实现**：`agent-fleet-core` 的
「舰队操作经 REST API 暴露」只把建岗/改岗的模型声明写成对等，未覆盖另外四个维度；
「岗位可声明思考深度并按回合生效」已经写明"三者皆无声明时 SHALL 沿用既有的
provider 级全局思考深度"——实现却沿用了活体值。

## What Changes

- **建岗接全配置维度**：POST 与 PATCH 共用同一套闸（`validateConfigDims`、
  `CARRIERS` 枚举、`packId` 形状），四项等价可写；非法值结构化拒绝且**不落库**。
  静默丢弃成为被禁止的行为，不是"待优化"。
- **清档即回到全局**：声明被清除（`null`/`""`）时，下一回合把运行中档位切回
  provider 默认，而不是沿用遗留值；切换仍走 live `model/set`（不重启），失败仍降级放行。
- **不做**：Web 建岗对话框不加这四个字段。既有流程是"先建岗、再在检查器里配"
  （`FleetsPage.tsx:2064` 的 POST 体只有 title/target/parent/cadence），本变更只补齐
  API 契约，不改交互；UI 侧要补是另一件事，需要单独裁。

## Impact

- Affected specs: `agent-fleet-core`（2 个 requirement 修订）
- Affected code: `server/routes/fleets.js`（POST 建岗）、`server/cron-runner.js`（回合档位落地）
- 无迁移、无新表、无新依赖：`server/routes/fleets-db.js:557` 的 `createMember`
  已写全这四列，缺的只是入口的读与校验。
