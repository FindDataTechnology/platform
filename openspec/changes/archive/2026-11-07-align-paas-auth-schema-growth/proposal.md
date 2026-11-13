# Document the loopback internal bridges and guarded schema growth

## Why

体检增量对账（N-2 auth 37 天、N-13 project-database 43 天）复核后的两处真实漂移，纯文本可修：

1. **auth（N-2）**：spec 09-28 的「Trust boundary and scope」只讲「转发身份头仅在代理独占可达时可信」，但 `server/auth.js:105-204` 此后长出 **11 个 loopback 内部桥**（cron/chart/delegation/fleet-architect/builder/skill-evolution/persona-evolution/save/actions/fleet…）；`535ee55ab` 还把桥面收紧为「loopback 即凭据 + 单动词 + 服务端归因 + 无 forwarded 身份头」。这是整片未入册的信任边界，按 spec 对账会漏。
2. **project-database（N-13）**：spec 表清单是 09-21 快照，`db.js` 45 次变更、迁移已到 v113、81 处 CREATE/ALTER；`bcd35dc8c` 和 v111 立下「表存在守卫，缺表跳过而非打断整链」纪律。spec 没有对新增 store 的入册约束。

**核过未动**：permission-mode-selection（40 天剪刀差，但危险确认/streaming 守卫/WS 契约逐条仍与 `ws.js:849-868`、`ControlStrip.tsx:230-272` 一致=日期假阳性）、miniprogram-auth（双路由挂载属实现细节，Purpose 措辞精度问题，不值得改契约）。

## What Changes

- `auth`：「Trust boundary and scope」补内部桥纪律 + 1 新场景。
- `project-database`：ADDED 一条「Schema growth is additive and guarded」+ 2 场景。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `auth`：信任边界 Requirement MODIFIED。
- `project-database`：新增一条 schema 演进 Requirement（ADDED）。

## Impact

- 仅 spec 文本；代码零改动。
