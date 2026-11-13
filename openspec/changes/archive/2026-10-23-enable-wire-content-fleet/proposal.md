# Proposal: enable-wire-content-fleet

## Why

柏讯（fd-wire）把三段生产能力打包成功能集，其中「柏讯 · 产物构建」内嵌一支 3 岗舰队模板，产物写入工具靠 `source_ref`（部署/岗位/回合三元组）标记生产来源。真跑时这条链路断在 paas 侧：**agent 在舰队成员回合内不知道自己是谁** —— 平台只在 cron 回合注入 `{{fleetContext}}`（下级报数 + 舰队概况 + 拍板 digest），不含任何岗位身份；被动岗（无节奏，靠 delegation 唤醒）连 `{{fleetContext}}` 都没有。模型只能自己编 `source_ref`，审计价值归零。

需求来源：`docs/wire-content-fleet-requirements.md`（fd-wire change `wire-content-fleet`）。该文档同时提了两件非阻断事项（P2 节奏冲突校验的落点、P3 `mcpServers` 上限 5）和三条验证项（V1-V3）。

已与用户确认：P2 选方案 A（paas 提供只读接口）、P3 提到 6、走 OpenSpec 先行。

## What Changes

- **P1（阻断级）岗位身份注入成员回合**：舰队成员回合开始时，岗位身份（`fleetId`、岗位 `ref`/`title`、`memberId`）以一行文本前缀进该回合的 prompt。注入点选在 `server/cron-runner.js` 的 persona 回合装配处 —— cron 节奏回合与 delegation 唤醒回合**共用**该处，因此被动岗同样覆盖。归属解析复用既有的 `resolveAttribution`（`server/fleet-reports.js`），不新增第二套身份判定。非舰队回合（persona 未在岗任何岗位）不注入，行为与现状一致。
- **P2 只读节奏契约**：新增 `GET /api/fleets/:id/cadence`，返回该舰队在岗岗位的 `{ref, title, cron, tz, targetRef}`，不含凭据与运行数据。柏讯在创建刷新调度时调用它，命中等价节奏即 409 并指向冲突岗位。
- **P3 pack 策略上限可配**：`maxMcpRefs` 默认 5 → 6；`maxSkills` / `maxAgents` / `maxMcpRefs` 三个**策略**上限改为运维可配（`PACK_MAX_SKILLS` / `PACK_MAX_AGENTS` / `PACK_MAX_MCP_REFS`，逐次读取、非法值回落默认），字符/字节护栏保持硬编码。四个已满编的分析套件因此可以追加产物构建服务，且以后调上限不再需要改代码。
- **验证项 V1-V3**：纯核对，不改代码；结论记入台账。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-fleet-report-lane`: ADDED 一条需求 —— 成员回合岗位身份注入（cron 与 delegation 两条唤醒路径均覆盖，非舰队回合不注入，身份不含凭据）。
- `agent-fleet-core`: ADDED 一条需求 —— 舰队节奏对外只读契约（给定 fleetId 返回在岗岗位的节奏与目标位，owner 作用域，无凭据/运行数据）。
- `agent-cluster-core`: MODIFIED —— pack 级上限 `mcpServers` 5 → 6，且 skills/agents/mcpServers 三个策略上限改为运维可配（默认 10/3/6）。

## Impact

- **代码**：`server/cron-runner.js`（身份前缀注入）、`server/fleet-reports.js` 或新小模块（身份行渲染）、`server/routes/fleets.js`（只读 cadence 路由）、`lib/pack-manifest.js`（一个常量）、`server.js`（注入 wiring）。无新依赖。
- **spec**：三份 delta。
- **测试**：`scripts/test-fleet-report-lane.mjs` 补身份注入用例；`scripts/test-fleet-templates.mjs` 或新增小测钉住 cadence 端点形状；pack 上限用例改 6。
- **出片**：需镜像出片（server/ 有改动）。
- **兼容性**：非舰队回合零变化；既有 `{{fleetContext}}` 语义不变（身份是额外前缀行，不是占位符替换）。
- **非目标**（承 fd-wire 文档）：不改 `refresh-scheduler` 的间隔地板与配额；不新建 agent 运行时/调度器/事件总线；不放开「带内容一步创建」的租户限制；不为内部/外部各做一份 pack。
